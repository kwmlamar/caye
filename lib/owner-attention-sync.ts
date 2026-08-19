import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getHeldSummary } from '@/lib/hold-kinds'
import {
  observeAttentionItem,
  setAttentionStatus,
  SUBJECT_CONVERSATION,
  SUBJECT_REMINDER,
  type AttentionPriority,
} from '@/lib/owner-attention'

const REMINDER_SCAN_CAP = 100

interface Candidate {
  subjectType: string
  subjectId: string
  conversationId: string | null
  title: string
  priority: AttentionPriority
  nextAction: string
  fingerprintParts?: unknown[]
}

interface HeldConvRow {
  id: string
  metadata: Record<string, unknown> | null
}

interface ReminderRow {
  id: string
  payload: Record<string, unknown> | null
  scheduled_for: string | null
}

/**
 * CAY-99: obvious courtesy acknowledgements are observations, not
 * developments. They must not re-earn owner attention just because the
 * conversation timestamp moved.
 */
export function isNonActionableOwnerObservation(args: {
  lastSenderType: string | null
  lastMessagePreview: string | null
}): boolean {
  if (args.lastSenderType !== 'customer') return false
  const raw = (args.lastMessagePreview ?? '').trim().toLowerCase()
  if (!raw) return false
  const normalized = raw
    .replace(/[.!?,;:]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return /^(?:thank you|thanks|thank you so much|thanks so much|many thanks|got it|okay|ok|sounds good|perfect|great|awesome|understood|noted|👍|🙏|😊|👌)$/.test(normalized)
}

export type OwnerAttentionReasonCode =
  | 'suppressed_duplicate'
  | 'suppressed_non_actionable'
  | 'surfaced_actionable'

export function ownerAttentionReasonCode(args: {
  nonActionable: boolean
  stateFingerprint?: string | null
  notifiedFingerprint?: string | null
}): OwnerAttentionReasonCode {
  if (args.nonActionable) return 'suppressed_non_actionable'
  if (
    args.stateFingerprint != null &&
    args.notifiedFingerprint != null &&
    args.stateFingerprint === args.notifiedFingerprint
  ) {
    return 'suppressed_duplicate'
  }
  return 'surfaced_actionable'
}

export async function syncOwnerAttention(workspaceId: string): Promise<void> {
  try {
    const supabase = createServiceClient()
    const candidates = new Map<string, Candidate>()
    const key = (c: { subjectType: string; subjectId: string }) => `${c.subjectType}:${c.subjectId}`

    const add = (c: Candidate) => {
      const existing = candidates.get(key(c))
      if (!existing) {
        candidates.set(key(c), c)
        return
      }
      candidates.set(key(c), {
        ...existing,
        priority: strongerPriority(existing.priority, c.priority),
        nextAction: c.nextAction || existing.nextAction,
        fingerprintParts:
          existing.fingerprintParts && c.fingerprintParts
            ? [...existing.fingerprintParts, ...c.fingerprintParts]
            : existing.fingerprintParts ?? c.fingerprintParts,
      })
    }

    const held = await getHeldSummary(supabase, workspaceId)
    const heldIds = held.attention.map((h) => h.id)
    const withDrafts = await conversationsWithDrafts(supabase, heldIds)
    const escalated = await conversationsWithOpenEscalations(supabase, heldIds)
    const todayISO = new Date().toISOString().slice(0, 10)

    for (const h of held.attention) {
      const datePassed = !!h.target_date && h.target_date < todayISO
      const hasDraft = withDrafts.has(h.id)
      const who = h.customer_name || h.customer_id || 'a customer'
      const nonActionable = isNonActionableOwnerObservation({
        lastSenderType: h.last_sender_type,
        lastMessagePreview: h.last_message_preview,
      })

      // Omitting fingerprintParts is deliberate. observeAttentionItem preserves
      // the previous fingerprint when no fingerprint is supplied, so a final
      // "Thank you!" cannot turn a previously-notified item into CHANGED. This
      // also avoids a one-time fingerprint migration that would itself create
      // owner noise after deploy.
      if (nonActionable) {
        console.info('[owner-attention-gate]', {
          reason_code: 'suppressed_non_actionable',
          workspaceId,
          conversationId: h.id,
        })
      }

      add({
        subjectType: SUBJECT_CONVERSATION,
        subjectId: h.id,
        conversationId: h.id,
        title: `${who} — ${(h.human_agent_reason ?? 'waiting on you').replace(/\s+/g, ' ').slice(0, 80)}`,
        priority: datePassed ? 'critical' : 'decision',
        nextAction: hasDraft
          ? 'Draft ready — needs your approval'
          : escalated.has(h.id)
            ? 'Waiting on your call'
            : 'Waiting on your reply',
        fingerprintParts: nonActionable
          ? undefined
          : [h.human_agent_reason, h.last_message_at, hasDraft, datePassed],
      })
    }

    const { data: reminders } = await supabase
      .from('caye_outbound_queue')
      .select('id, payload, scheduled_for')
      .eq('workspace_id', workspaceId)
      .eq('kind', 'operator_reminder')
      .eq('status', 'pending')
      .order('scheduled_for', { ascending: true })
      .limit(REMINDER_SCAN_CAP)

    for (const r of (reminders ?? []) as ReminderRow[]) {
      const asked =
        typeof r.payload?.original_request === 'string'
          ? r.payload.original_request
          : typeof r.payload?.body === 'string'
            ? r.payload.body
            : 'a reminder'
      add({
        subjectType: SUBJECT_REMINDER,
        subjectId: r.id,
        conversationId: null,
        title: `Reminder — ${asked.replace(/\s+/g, ' ').slice(0, 80)}`,
        priority: 'awareness',
        nextAction: r.scheduled_for ? `Fires ${r.scheduled_for}` : 'Scheduled',
        fingerprintParts: [asked, r.scheduled_for],
      })
    }

    for (const c of candidates.values()) {
      await observeAttentionItem({
        workspaceId,
        subjectType: c.subjectType,
        subjectId: c.subjectId,
        conversationId: c.conversationId,
        title: c.title,
        priority: c.priority,
        nextAction: c.nextAction,
        fingerprintParts: c.fingerprintParts,
      })
    }

    const owned = [SUBJECT_CONVERSATION, SUBJECT_REMINDER]
    const { data: openRows } = await supabase
      .from('caye_owner_attention')
      .select('subject_type, subject_id')
      .eq('workspace_id', workspaceId)
      .in('status', ['open', 'acknowledged', 'decided'])
      .in('subject_type', owned)

    const ownedSet = new Set(owned)
    for (const row of (openRows ?? []) as Array<{ subject_type: string; subject_id: string }>) {
      if (!ownedSet.has(row.subject_type)) continue
      if (candidates.has(`${row.subject_type}:${row.subject_id}`)) continue
      await setAttentionStatus({
        workspaceId,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        status: 'resolved',
      })
    }
  } catch (err) {
    console.error('[owner-attention-sync] threw:', err)
  }
}

const PRIORITY_STRENGTH: Record<AttentionPriority, number> = {
  critical: 3,
  decision: 2,
  awareness: 1,
  routine: 0,
}

function strongerPriority(a: AttentionPriority, b: AttentionPriority): AttentionPriority {
  return PRIORITY_STRENGTH[a] >= PRIORITY_STRENGTH[b] ? a : b
}

async function conversationsWithDrafts(
  supabase: ReturnType<typeof createServiceClient>,
  conversationIds: string[]
): Promise<Set<string>> {
  const out = new Set<string>()
  if (conversationIds.length === 0) return out

  const { data: convs } = await supabase
    .from('unified_conversations')
    .select('id, metadata')
    .in('id', conversationIds)
  for (const c of (convs ?? []) as HeldConvRow[]) {
    const proposed = c.metadata?.proposed_reply
    if (typeof proposed === 'string' && proposed.trim()) out.add(c.id)
  }

  const { data: msgs } = await supabase
    .from('unified_messages')
    .select('conversation_id, metadata')
    .in('conversation_id', conversationIds)
    .eq('is_internal', true)
  for (const m of (msgs ?? []) as Array<{
    conversation_id: string
    metadata: Record<string, unknown> | null
  }>) {
    const proposed = m.metadata?.proposed_reply
    if (typeof proposed === 'string' && proposed.trim()) out.add(m.conversation_id)
  }

  return out
}

async function conversationsWithOpenEscalations(
  supabase: ReturnType<typeof createServiceClient>,
  conversationIds: string[]
): Promise<Set<string>> {
  const out = new Set<string>()
  if (conversationIds.length === 0) return out
  const { data } = await supabase
    .from('caye_escalations')
    .select('conversation_id')
    .in('conversation_id', conversationIds)
    .is('owner_responded_at', null)
    .is('expired_at', null)
  for (const e of (data ?? []) as Array<{ conversation_id: string | null }>) {
    if (e.conversation_id) out.add(e.conversation_id)
  }
  return out
}
