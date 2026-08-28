import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'
import { resolveFounderOperator } from '@/lib/operator-identity'
import type { RichResult } from './caye-direct-rich-results'

/**
 * Founder-facing topic threads over Caye Direct (2026-08-13).
 *
 * caye_operator_messages stays the canonical, untouched raw-event log for
 * BOTH WhatsApp operator turns and dashboard turns — nothing here writes
 * to it directly except linkMessageToThread's join row. A thread is a
 * pure organization layer: see supabase/migrations/20260813_caye_direct_threads.sql
 * for the full rationale (why a join table instead of a thread_id column,
 * why the name avoids colliding with the unrelated customer-dashboard
 * caye_threads/caye_messages pair).
 */

export type ThreadSubjectType =
  | 'person'
  | 'inbox_conversation'
  | 'booking'
  | 'lead'
  | 'escalation'
  | 'business_fact'
  | 'work_item'

export interface DirectThread {
  id: string
  workspace_id: string
  title: string | null
  status: 'active' | 'archived'
  summary: string | null
  summary_updated_at: string | null
  created_by: 'founder' | 'caye'
  last_activity_at: string
  created_at: string
  updated_at: string
  pinned_at: string | null
}

export interface ThreadEntity {
  subject_type: ThreadSubjectType | string
  subject_id: string
}

type SupabaseClient = ReturnType<typeof createServiceClient>

/** Lamar clicking "+ New conversation" — empty thread, no subject yet. */
export async function createThread(
  supabase: SupabaseClient,
  args: { workspaceId: string; createdBy: 'founder' | 'caye'; title?: string | null }
): Promise<DirectThread> {
  const { data, error } = await supabase
    .from('caye_direct_threads')
    .insert({
      workspace_id: args.workspaceId,
      created_by: args.createdBy,
      title: args.title ?? null,
    })
    .select('*')
    .single()
  if (error) throw new Error(`[caye-direct-threads] createThread failed: ${error.message}`)
  return data as DirectThread
}

/**
 * Find-or-create keyed by (workspace, subject). This is what makes Caye's
 * second mention of the same subject ("Emily replied") land in the SAME
 * thread instead of spawning "Emily update 2" — see
 * lib/caye-agent/modes/back-office.ts's relate_to_direct_thread tool and
 * the escalation-followup/opportunity-scan call sites.
 *
 * Only reuses ACTIVE threads — an archived thread about the same subject
 * stays closed; a genuinely new occurrence gets a fresh thread.
 */
export async function getOrCreateDirectThread(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    subjectType: ThreadSubjectType | string
    subjectId: string
    titleHint: string
    createdBy: 'founder' | 'caye'
  }
): Promise<{ thread: DirectThread; reused: boolean }> {
  const { data: existing, error: lookupErr } = await supabase
    .from('caye_direct_thread_entities')
    .select('thread_id, caye_direct_threads!inner(*)')
    .eq('subject_type', args.subjectType)
    .eq('subject_id', args.subjectId)
    .eq('caye_direct_threads.workspace_id', args.workspaceId)
    .eq('caye_direct_threads.status', 'active')
    .limit(1)
    .maybeSingle()
  if (lookupErr) {
    throw new Error(`[caye-direct-threads] getOrCreateDirectThread lookup failed: ${lookupErr.message}`)
  }

  if (existing) {
    const thread = (existing as unknown as { caye_direct_threads: DirectThread }).caye_direct_threads
    await touchThread(supabase, thread.id)
    return { thread: { ...thread, last_activity_at: new Date().toISOString() }, reused: true }
  }

  const thread = await createThread(supabase, {
    workspaceId: args.workspaceId,
    createdBy: args.createdBy,
    title: args.titleHint || null,
  })

  const { error: linkErr } = await supabase.from('caye_direct_thread_entities').insert({
    thread_id: thread.id,
    subject_type: args.subjectType,
    subject_id: args.subjectId,
  })
  if (linkErr) {
    throw new Error(`[caye-direct-threads] getOrCreateDirectThread entity link failed: ${linkErr.message}`)
  }

  return { thread, reused: false }
}

/**
 * Link every newly-inserted caye_operator_messages row from one agent turn
 * to every thread the relate_to_direct_thread tool requested during that
 * turn — see CayeAgentResult.linkedThreadIds. No-ops instantly when either
 * list is empty, which is the overwhelming majority of WhatsApp turns.
 */
export async function linkInsertedMessagesToThreads(
  supabase: SupabaseClient,
  insertedMessageIds: string[],
  threadIds: string[],
  linkedBy: 'caye' | 'system' = 'caye'
): Promise<void> {
  if (insertedMessageIds.length === 0 || threadIds.length === 0) return
  await Promise.all(
    threadIds.flatMap((threadId) =>
      insertedMessageIds.map((messageId) => linkMessageToThread(supabase, threadId, messageId, linkedBy))
    )
  )
}

/** Link a caye_operator_messages row into a thread. Idempotent (PK is the pair). */
export async function linkMessageToThread(
  supabase: SupabaseClient,
  threadId: string,
  messageId: string,
  linkedBy: 'founder' | 'caye' | 'system'
): Promise<void> {
  const { error } = await supabase
    .from('caye_direct_thread_messages')
    .upsert(
      { thread_id: threadId, message_id: messageId, linked_by: linkedBy },
      { onConflict: 'thread_id,message_id', ignoreDuplicates: true }
    )
  if (error) throw new Error(`[caye-direct-threads] linkMessageToThread failed: ${error.message}`)
}

/** Attach a pointer to a canonical entity without duplicating its data. */
export async function linkThreadEntity(
  supabase: SupabaseClient,
  threadId: string,
  subjectType: ThreadSubjectType | string,
  subjectId: string
): Promise<void> {
  const { error } = await supabase
    .from('caye_direct_thread_entities')
    .upsert(
      { thread_id: threadId, subject_type: subjectType, subject_id: subjectId },
      { onConflict: 'thread_id,subject_type,subject_id', ignoreDuplicates: true }
    )
  if (error) throw new Error(`[caye-direct-threads] linkThreadEntity failed: ${error.message}`)
}

export async function touchThread(supabase: SupabaseClient, threadId: string): Promise<void> {
  const now = new Date().toISOString()
  await supabase
    .from('caye_direct_threads')
    .update({ last_activity_at: now, updated_at: now })
    .eq('id', threadId)
}

export interface ThreadListItem {
  id: string
  title: string | null
  status: 'active' | 'archived'
  last_activity_at: string
  created_by: 'founder' | 'caye'
  pinned_at: string | null
}

/** Sidebar list — client buckets these into Pinned/Today/Yesterday/Previous 7 days/Older. */
export async function listThreads(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { q?: string; status?: 'active' | 'archived' } = {}
): Promise<ThreadListItem[]> {
  let query = supabase
    .from('caye_direct_threads')
    .select('id, title, status, last_activity_at, created_by, pinned_at')
    .eq('workspace_id', workspaceId)
    .eq('status', opts.status ?? 'active')

  if (opts.q?.trim()) {
    const q = opts.q.trim().replace(/[%_]/g, (m) => `\\${m}`)
    query = query.or(`title.ilike.%${q}%,summary.ilike.%${q}%`)
  }

  const { data, error } = await query.order('last_activity_at', { ascending: false }).limit(200)
  if (error) throw new Error(`[caye-direct-threads] listThreads failed: ${error.message}`)
  return (data ?? []) as ThreadListItem[]
}

export async function getThread(
  supabase: SupabaseClient,
  workspaceId: string,
  threadId: string
): Promise<DirectThread | null> {
  const { data, error } = await supabase
    .from('caye_direct_threads')
    .select('*')
    .eq('id', threadId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(`[caye-direct-threads] getThread failed: ${error.message}`)
  return (data as DirectThread | null) ?? null
}

export async function getThreadEntities(
  supabase: SupabaseClient,
  threadId: string
): Promise<ThreadEntity[]> {
  const { data, error } = await supabase
    .from('caye_direct_thread_entities')
    .select('subject_type, subject_id')
    .eq('thread_id', threadId)
  if (error) throw new Error(`[caye-direct-threads] getThreadEntities failed: ${error.message}`)
  return (data ?? []) as ThreadEntity[]
}

export async function renameThread(
  supabase: SupabaseClient,
  workspaceId: string,
  threadId: string,
  title: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('caye_direct_threads')
    .update({ title: title.trim().slice(0, 120), updated_at: new Date().toISOString() })
    .eq('id', threadId)
    .eq('workspace_id', workspaceId)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`[caye-direct-threads] renameThread failed: ${error.message}`)
  return !!data
}

export async function setThreadStatus(
  supabase: SupabaseClient,
  workspaceId: string,
  threadId: string,
  status: 'active' | 'archived'
): Promise<boolean> {
  const { data, error } = await supabase
    .from('caye_direct_threads')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', threadId)
    .eq('workspace_id', workspaceId)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`[caye-direct-threads] setThreadStatus failed: ${error.message}`)
  return !!data
}

/** pinned_at doubles as the boolean flag and the Pinned-section sort key
 *  (most-recently-pinned first) — see the 20260828 migration's comment. */
export async function setThreadPinned(
  supabase: SupabaseClient,
  workspaceId: string,
  threadId: string,
  pinned: boolean
): Promise<boolean> {
  const { data, error } = await supabase
    .from('caye_direct_threads')
    .update({ pinned_at: pinned ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq('id', threadId)
    .eq('workspace_id', workspaceId)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`[caye-direct-threads] setThreadPinned failed: ${error.message}`)
  return !!data
}

/** Hard delete — the sidebar's "Delete" menu item, distinct from Archive.
 *  Only removes this organization layer (the thread row and its join rows,
 *  via FK cascade); caye_operator_messages stays the untouched raw-event
 *  log exactly as the 20260813 migration's comment describes. */
export async function deleteThread(
  supabase: SupabaseClient,
  workspaceId: string,
  threadId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('caye_direct_threads')
    .delete()
    .eq('id', threadId)
    .eq('workspace_id', workspaceId)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`[caye-direct-threads] deleteThread failed: ${error.message}`)
  return !!data
}

export interface ThreadMessageRow {
  id: string
  direction: 'inbound' | 'outbound'
  body: string
  created_at: string
  origin: 'whatsapp' | 'dashboard'
  operator_name: string | null
  operator_role: string | null
  wa_delivery_status: string | null
  wa_delivery_error: string | null
  rich_result?: RichResult | null
}

/**
 * Caye deciding, unprompted, that something is genuinely conversation-
 * worthy for the founder — the Direct-thread counterpart to a cron job's
 * existing WhatsApp/notification ping. Opt-in per call site (not every
 * proactive event should do this — see escalation-followup's founder
 * backstop and opportunity-scan for the two v1 call sites), and reuses an
 * existing open thread for the same subject exactly like
 * relate_to_direct_thread does, so a second occurrence of the same issue
 * doesn't spawn a duplicate thread.
 *
 * The message is attributed to the workspace's founder operator row
 * (Direct threads are founder-facing only) with origin 'dashboard' — it
 * never went out over WhatsApp, it originates in Direct itself.
 */
export async function createCayeInitiatedThreadMessage(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    subjectType: ThreadSubjectType | string
    subjectId: string
    titleHint: string
    message: string
  }
): Promise<{ thread: DirectThread; reused: boolean } | null> {
  const founderOperator = await resolveFounderOperator(supabase, args.workspaceId)

  const { thread, reused } = await getOrCreateDirectThread(supabase, {
    workspaceId: args.workspaceId,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    titleHint: args.titleHint,
    createdBy: 'caye',
  })

  const { data: row, error } = await supabase
    .from('caye_operator_messages')
    .insert({
      workspace_id: args.workspaceId,
      direction: 'outbound',
      wa_message_id: null,
      body: args.message,
      intent: null,
      claude_format: { role: 'assistant', content: args.message },
      operator_allowlist_id: founderOperator?.id ?? null,
      operator_name: founderOperator?.name ?? null,
      operator_role: founderOperator?.role ?? 'founder',
      origin: 'dashboard',
    })
    .select('id')
    .single()
  if (error) throw new Error(`[caye-direct-threads] createCayeInitiatedThreadMessage insert failed: ${error.message}`)

  if (row?.id) await linkMessageToThread(supabase, thread.id, row.id, 'caye')
  await touchThread(supabase, thread.id)

  return { thread, reused }
}

/**
 * Minimal display label for a linked entity, resolved from the canonical
 * table by id — never duplicates the entity's data, just names it for the
 * thread-detail UI and the agent's threadContext prompt block. Covers the
 * subject types actually produced by relate_to_direct_thread and the
 * Caye-initiated call sites today; unrecognized/unresolvable pointers fall
 * back to a generic label rather than failing the whole thread load.
 */
export async function describeEntity(
  supabase: SupabaseClient,
  entity: ThreadEntity
): Promise<string> {
  try {
    switch (entity.subject_type) {
      case 'escalation': {
        const { data } = await supabase
          .from('caye_escalations')
          .select('category, customer_facing_message')
          .eq('id', entity.subject_id)
          .maybeSingle()
        if (data) {
          const preview = (data.customer_facing_message as string | null)?.slice(0, 60) ?? ''
          return `Escalation${data.category ? ` (${data.category})` : ''}${preview ? ` — ${preview}` : ''}`
        }
        break
      }
      case 'inbox_conversation': {
        const { data } = await supabase
          .from('unified_conversations')
          .select('customer_name')
          .eq('id', entity.subject_id)
          .maybeSingle()
        if (data?.customer_name) return `Conversation with ${data.customer_name}`
        break
      }
      case 'person': {
        const { data } = await supabase
          .from('contacts')
          .select('name, email, phone_number')
          .eq('id', entity.subject_id)
          .maybeSingle()
        if (data) return data.name || data.email || data.phone_number || 'Person'
        break
      }
      case 'lead': {
        const { data } = await supabase
          .from('outreach_leads')
          .select('business_name, contact_name, lead_email')
          .eq('id', entity.subject_id)
          .maybeSingle()
        if (data) return data.business_name || data.contact_name || data.lead_email || 'Lead'
        break
      }
      default:
        break
    }
  } catch {
    // Fall through to the generic label — a resolution failure should
    // never block loading the rest of the thread.
  }
  return `${entity.subject_type} ${entity.subject_id}`
}

/** Raw linked messages for a thread, oldest-first. Caller applies visibility filtering. */
export async function getThreadMessages(
  supabase: SupabaseClient,
  threadId: string,
  limit = 200
): Promise<ThreadMessageRow[]> {
  const { data: links, error: linkErr } = await supabase
    .from('caye_direct_thread_messages')
    .select('message_id')
    .eq('thread_id', threadId)
  if (linkErr) throw new Error(`[caye-direct-threads] getThreadMessages link lookup failed: ${linkErr.message}`)

  const messageIds = (links ?? []).map((r) => r.message_id as string)
  if (messageIds.length === 0) return []

  const { data, error } = await supabase
    .from('caye_operator_messages')
    .select('id, direction, body, created_at, origin, operator_name, operator_role, wa_delivery_status, wa_delivery_error, rich_result')
    .in('id', messageIds)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`[caye-direct-threads] getThreadMessages failed: ${error.message}`)
  return (data ?? []) as ThreadMessageRow[]
}
