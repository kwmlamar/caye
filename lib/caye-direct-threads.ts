import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'
import { resolveFounderOperator } from '@/lib/operator-identity'
import type { RichResult } from './caye-direct-rich-results'

/**
 * Founder-facing topic threads over Caye Direct.
 *
 * caye_operator_messages remains the canonical raw-event log. Direct threads
 * are an organization layer over those messages. Since 2026-08-28 the thread
 * itself is founder-scoped: changing dashboard workspace does not hide the
 * founder's conversation history. Each actual agent turn still executes
 * against one explicit active_workspace_id so tenant boundaries remain real.
 */

export type ThreadSubjectType =
  | 'person'
  | 'inbox_conversation'
  | 'booking'
  | 'lead'
  | 'escalation'
  | 'business_fact'
  | 'work_item'
  | 'property'

export interface DirectThread {
  id: string
  /** Stable origin/home workspace, retained for provenance and proactive reuse. */
  workspace_id: string
  /** Explicit workspace context for the next founder Direct turn. */
  active_workspace_id: string
  scope_kind: 'founder'
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

export async function createThread(
  supabase: SupabaseClient,
  args: { workspaceId: string; createdBy: 'founder' | 'caye'; title?: string | null }
): Promise<DirectThread> {
  const { data, error } = await supabase
    .from('caye_direct_threads')
    .insert({
      workspace_id: args.workspaceId,
      active_workspace_id: args.workspaceId,
      scope_kind: 'founder',
      created_by: args.createdBy,
      title: args.title ?? null,
    })
    .select('*')
    .single()
  if (error) throw new Error(`[caye-direct-threads] createThread failed: ${error.message}`)
  return data as DirectThread
}

/**
 * Proactive Caye events remain keyed by HOME workspace + subject. The thread
 * is globally visible to the founder, but a Bimini escalation should not
 * collapse onto an identically-shaped TropiTech subject.
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
  if (lookupErr) throw new Error(`[caye-direct-threads] getOrCreateDirectThread lookup failed: ${lookupErr.message}`)

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
  if (linkErr) throw new Error(`[caye-direct-threads] getOrCreateDirectThread entity link failed: ${linkErr.message}`)
  return { thread, reused: false }
}

export async function linkInsertedMessagesToThreads(
  supabase: SupabaseClient,
  insertedMessageIds: string[],
  threadIds: string[],
  linkedBy: 'caye' | 'system' = 'caye'
): Promise<void> {
  if (insertedMessageIds.length === 0 || threadIds.length === 0) return
  await Promise.all(threadIds.flatMap((threadId) => insertedMessageIds.map((messageId) => linkMessageToThread(supabase, threadId, messageId, linkedBy))))
}

export async function linkMessageToThread(
  supabase: SupabaseClient,
  threadId: string,
  messageId: string,
  linkedBy: 'founder' | 'caye' | 'system'
): Promise<void> {
  const { error } = await supabase
    .from('caye_direct_thread_messages')
    .upsert({ thread_id: threadId, message_id: messageId, linked_by: linkedBy }, { onConflict: 'thread_id,message_id', ignoreDuplicates: true })
  if (error) throw new Error(`[caye-direct-threads] linkMessageToThread failed: ${error.message}`)
}

export async function linkThreadEntity(
  supabase: SupabaseClient,
  threadId: string,
  subjectType: ThreadSubjectType | string,
  subjectId: string
): Promise<void> {
  const { error } = await supabase
    .from('caye_direct_thread_entities')
    .upsert({ thread_id: threadId, subject_type: subjectType, subject_id: subjectId }, { onConflict: 'thread_id,subject_type,subject_id', ignoreDuplicates: true })
  if (error) throw new Error(`[caye-direct-threads] linkThreadEntity failed: ${error.message}`)
}

export async function touchThread(supabase: SupabaseClient, threadId: string): Promise<void> {
  const now = new Date().toISOString()
  await supabase.from('caye_direct_threads').update({ last_activity_at: now, updated_at: now }).eq('id', threadId)
}

export interface ThreadListItem {
  id: string
  title: string | null
  status: 'active' | 'archived'
  last_activity_at: string
  created_by: 'founder' | 'caye'
  pinned_at: string | null
  scope_kind: 'founder'
  active_workspace_id: string
  active_workspace_name: string | null
}

/** Founder Direct sidebar is global by default. workspaceId is an opt-in filter. */
export async function listThreads(
  supabase: SupabaseClient,
  workspaceId: string | null,
  opts: { q?: string; status?: 'active' | 'archived' } = {}
): Promise<ThreadListItem[]> {
  let query = supabase
    .from('caye_direct_threads')
    .select('id, title, status, last_activity_at, created_by, pinned_at, scope_kind, active_workspace_id')
    .eq('scope_kind', 'founder')
    .eq('status', opts.status ?? 'active')

  if (workspaceId) query = query.eq('active_workspace_id', workspaceId)
  if (opts.q?.trim()) {
    const q = opts.q.trim().replace(/[%_]/g, (m) => `\\${m}`)
    query = query.or(`title.ilike.%${q}%,summary.ilike.%${q}%`)
  }

  const { data, error } = await query.order('last_activity_at', { ascending: false }).limit(200)
  if (error) throw new Error(`[caye-direct-threads] listThreads failed: ${error.message}`)

  const rows = (data ?? []) as Omit<ThreadListItem, 'active_workspace_name'>[]
  const workspaceIds = [...new Set(rows.map((row) => row.active_workspace_id).filter(Boolean))]
  const nameById = new Map<string, string | null>()
  if (workspaceIds.length > 0) {
    const { data: workspaces, error: workspaceErr } = await supabase.from('customers').select('id, business_name').in('id', workspaceIds)
    if (workspaceErr) throw new Error(`[caye-direct-threads] workspace labels failed: ${workspaceErr.message}`)
    for (const workspace of workspaces ?? []) nameById.set(workspace.id as string, (workspace.business_name as string | null) ?? null)
  }
  return rows.map((row) => ({ ...row, active_workspace_name: nameById.get(row.active_workspace_id) ?? null }))
}

/** Founder-authenticated server routes may resolve a thread independent of workspace. */
export async function getFounderThreadById(
  supabase: SupabaseClient,
  threadId: string
): Promise<DirectThread | null> {
  const { data, error } = await supabase
    .from('caye_direct_threads')
    .select('*')
    .eq('id', threadId)
    .eq('scope_kind', 'founder')
    .maybeSingle()
  if (error) throw new Error(`[caye-direct-threads] getFounderThreadById failed: ${error.message}`)
  return (data as DirectThread | null) ?? null
}

/** Runtime/tool path: requires the explicit active workspace to match. */
export async function getThread(
  supabase: SupabaseClient,
  workspaceId: string,
  threadId: string
): Promise<DirectThread | null> {
  const { data, error } = await supabase
    .from('caye_direct_threads')
    .select('*')
    .eq('id', threadId)
    .eq('scope_kind', 'founder')
    .eq('active_workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(`[caye-direct-threads] getThread failed: ${error.message}`)
  return (data as DirectThread | null) ?? null
}

export async function getThreadEntities(supabase: SupabaseClient, threadId: string): Promise<ThreadEntity[]> {
  const { data, error } = await supabase.from('caye_direct_thread_entities').select('subject_type, subject_id').eq('thread_id', threadId)
  if (error) throw new Error(`[caye-direct-threads] getThreadEntities failed: ${error.message}`)
  return (data ?? []) as ThreadEntity[]
}

export async function renameThread(supabase: SupabaseClient, workspaceId: string, threadId: string, title: string): Promise<boolean> {
  const { data, error } = await supabase.from('caye_direct_threads')
    .update({ title: title.trim().slice(0, 120), updated_at: new Date().toISOString() })
    .eq('id', threadId).eq('scope_kind', 'founder').eq('active_workspace_id', workspaceId).select('id').maybeSingle()
  if (error) throw new Error(`[caye-direct-threads] renameThread failed: ${error.message}`)
  return !!data
}

export async function setThreadStatus(supabase: SupabaseClient, workspaceId: string, threadId: string, status: 'active' | 'archived'): Promise<boolean> {
  const { data, error } = await supabase.from('caye_direct_threads')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', threadId).eq('scope_kind', 'founder').eq('active_workspace_id', workspaceId).select('id').maybeSingle()
  if (error) throw new Error(`[caye-direct-threads] setThreadStatus failed: ${error.message}`)
  return !!data
}

export async function setThreadPinned(supabase: SupabaseClient, workspaceId: string, threadId: string, pinned: boolean): Promise<boolean> {
  const { data, error } = await supabase.from('caye_direct_threads')
    .update({ pinned_at: pinned ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq('id', threadId).eq('scope_kind', 'founder').eq('active_workspace_id', workspaceId).select('id').maybeSingle()
  if (error) throw new Error(`[caye-direct-threads] setThreadPinned failed: ${error.message}`)
  return !!data
}

/** CAS context move. The old workspace must still be active when the update lands. */
export async function setThreadActiveWorkspace(
  supabase: SupabaseClient,
  currentWorkspaceId: string,
  threadId: string,
  nextWorkspaceId: string
): Promise<boolean> {
  const { data: workspace, error: workspaceErr } = await supabase.from('customers').select('id').eq('id', nextWorkspaceId).maybeSingle()
  if (workspaceErr) throw new Error(`[caye-direct-threads] target workspace lookup failed: ${workspaceErr.message}`)
  if (!workspace) return false

  const { data, error } = await supabase.from('caye_direct_threads')
    .update({ active_workspace_id: nextWorkspaceId, updated_at: new Date().toISOString() })
    .eq('id', threadId).eq('scope_kind', 'founder').eq('active_workspace_id', currentWorkspaceId).select('id').maybeSingle()
  if (error) throw new Error(`[caye-direct-threads] setThreadActiveWorkspace failed: ${error.message}`)
  return !!data
}

export async function deleteThread(supabase: SupabaseClient, workspaceId: string, threadId: string): Promise<boolean> {
  const { data, error } = await supabase.from('caye_direct_threads').delete()
    .eq('id', threadId).eq('scope_kind', 'founder').eq('active_workspace_id', workspaceId).select('id').maybeSingle()
  if (error) throw new Error(`[caye-direct-threads] deleteThread failed: ${error.message}`)
  return !!data
}

export interface ThreadMessageRow {
  id: string
  workspace_id: string
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

export async function createCayeInitiatedThreadMessage(
  supabase: SupabaseClient,
  args: { workspaceId: string; subjectType: ThreadSubjectType | string; subjectId: string; titleHint: string; message: string }
): Promise<{ thread: DirectThread; reused: boolean } | null> {
  const founderOperator = await resolveFounderOperator(supabase, args.workspaceId)
  const { thread, reused } = await getOrCreateDirectThread(supabase, { ...args, createdBy: 'caye' })
  const { data: row, error } = await supabase.from('caye_operator_messages').insert({
    workspace_id: args.workspaceId, direction: 'outbound', wa_message_id: null, body: args.message, intent: null,
    claude_format: { role: 'assistant', content: args.message }, operator_allowlist_id: founderOperator?.id ?? null,
    operator_name: founderOperator?.name ?? null, operator_role: founderOperator?.role ?? 'founder', origin: 'dashboard',
  }).select('id').single()
  if (error) throw new Error(`[caye-direct-threads] createCayeInitiatedThreadMessage insert failed: ${error.message}`)
  if (row?.id) await linkMessageToThread(supabase, thread.id, row.id, 'caye')
  await touchThread(supabase, thread.id)
  return { thread, reused }
}

export async function describeEntity(supabase: SupabaseClient, entity: ThreadEntity): Promise<string> {
  try {
    switch (entity.subject_type) {
      case 'escalation': {
        const { data } = await supabase.from('caye_escalations').select('category, customer_facing_message').eq('id', entity.subject_id).maybeSingle()
        if (data) {
          const preview = (data.customer_facing_message as string | null)?.slice(0, 60) ?? ''
          return `Escalation${data.category ? ` (${data.category})` : ''}${preview ? ` — ${preview}` : ''}`
        }
        break
      }
      case 'inbox_conversation': {
        const { data } = await supabase.from('unified_conversations').select('customer_name').eq('id', entity.subject_id).maybeSingle()
        if (data?.customer_name) return `Conversation with ${data.customer_name}`
        break
      }
      case 'person': {
        const { data } = await supabase.from('contacts').select('name, email, phone_number').eq('id', entity.subject_id).maybeSingle()
        if (data) return data.name || data.email || data.phone_number || 'Person'
        break
      }
      case 'lead': {
        const { data } = await supabase.from('outreach_leads').select('business_name, contact_name, lead_email').eq('id', entity.subject_id).maybeSingle()
        if (data) return data.business_name || data.contact_name || data.lead_email || 'Lead'
        break
      }
      case 'property': {
        const { data } = await supabase.from('physical_properties').select('name').eq('id', entity.subject_id).maybeSingle()
        if (data?.name) return `Property: ${data.name}`
        break
      }
      default: break
    }
  } catch {}
  return `${entity.subject_type} ${entity.subject_id}`
}

export async function getThreadMessages(supabase: SupabaseClient, threadId: string, limit = 200): Promise<ThreadMessageRow[]> {
  const { data: links, error: linkErr } = await supabase.from('caye_direct_thread_messages').select('message_id').eq('thread_id', threadId)
  if (linkErr) throw new Error(`[caye-direct-threads] getThreadMessages link lookup failed: ${linkErr.message}`)
  const messageIds = (links ?? []).map((r) => r.message_id as string)
  if (messageIds.length === 0) return []
  const { data, error } = await supabase.from('caye_operator_messages')
    .select('id, workspace_id, direction, body, created_at, origin, operator_name, operator_role, wa_delivery_status, wa_delivery_error, rich_result')
    .in('id', messageIds).order('created_at', { ascending: true }).limit(limit)
  if (error) throw new Error(`[caye-direct-threads] getThreadMessages failed: ${error.message}`)
  return (data ?? []) as ThreadMessageRow[]
}
