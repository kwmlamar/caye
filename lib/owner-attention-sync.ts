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

/**
 * Reconcile the shared attention ledger against the state the business is
 * actually in.
 *
 * WHY A RECONCILER AND NOT observe() AT EVERY PRODUCER (2026-08-12b)
 * Seventeen separate call sites set `unified_conversations.human_agent_enabled
 * = true` — webhooks for five channels, two email pollers, the outreach nudge
 * scan, the admin respond route, caye-reply itself. Asking each to remember an
 * `observeAttentionItem` call is exactly the drift that put "[operator_reminder]"
 * in Mrs. Max's thread: two code paths that must agree, with nothing enforcing
 * that they do. The eighteenth producer would forget, and `allClear` would
 * quietly start lying again.
 *
 * So the ledger is DERIVED, not pushed. The canonical sources already exist and
 * are already the thing every read tool trusts; this reads them and syncs. A new
 * hold path added tomorrow is covered the moment it flips the flag nobody has to
 * remember anything.
 *
 * escalation.ts still calls observeAttentionItem directly at composition time —
 * not as a competing producer, but because that is the only moment the digest
 * and the composed brief exist. This sync then owns the item's lifecycle from
 * there. Both write the SAME row (see the identity rule below), so they
 * reinforce rather than duplicate.
 *
 * IDENTITY IS THE THING THE OWNER ACTS ON, NOT THE RECORD THAT NOTICED IT.
 * An escalation, a held thread, and a drafted reply awaiting approval can all
 * describe one conversation. The owner experiences ONE item. So anything
 * conversation-backed is keyed by conversation id under SUBJECT_CONVERSATION,
 * and the contributors raise its priority rather than adding rows. Keying on
 * escalation id would have produced two ledger entries for one thread — the
 * duplicate-record failure this rule exists to prevent.
 */

/** Bound the reconcile. Well above anything real; exists to cap worst case. */
const REMINDER_SCAN_CAP = 100

interface Candidate {
  subjectType: string
  subjectId: string
  conversationId: string | null
  title: string
  priority: AttentionPriority
  nextAction: string
  fingerprintParts: unknown[]
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
 * Bring the ledger in line with reality for one workspace.
 *
 * Adds/updates a row for everything currently needing the owner, and resolves
 * every row this sync owns whose underlying item is gone. Never throws — a
 * bookkeeping failure must not take down the briefing that calls it.
 */
export async function syncOwnerAttention(workspaceId: string): Promise<void> {
  try {
    const supabase = createServiceClient()
    const candidates = new Map<string, Candidate>()
    const key = (c: { subjectType: string; subjectId: string }) => `${c.subjectType}:${c.subjectId}`

    /** Merge a candidate in, keeping the strongest priority seen for it. */
    const add = (c: Candidate) => {
      const existing = candidates.get(key(c))
      if (!existing) {
        candidates.set(key(c), c)
        return
      }
      candidates.set(key(c), {
        ...existing,
        priority: strongerPriority(existing.priority, c.priority),
        // The more specific next action wins — "approve the draft" tells the
        // owner more than "someone's waiting".
        nextAction: c.nextAction || existing.nextAction,
        fingerprintParts: [...existing.fingerprintParts, ...c.fingerprintParts],
      })
    }

    // ── 1. Held conversations ────────────────────────────────────────────
    // getHeldSummary is the canonical "a person is waiting on the owner" read
    // (lib/hold-kinds.ts) and already excludes queue holds — drafted cold
    // outreach nobody is waiting on. Reusing it means the ledger and
    // get_held_queue can never disagree about what counts.
    const held = await getHeldSummary(supabase, workspaceId)
    const heldIds = held.attention.map((h) => h.id)

    // Which held threads carry a draft awaiting approval. Same two sources
    // get_pending_quotes uses: the conversation's own metadata.proposed_reply
    // (outreach path) and the latest internal note carrying one (reply path).
    const withDrafts = await conversationsWithDrafts(supabase, heldIds)

    // Which held threads have an open escalation — the tier that means Caye
    // deliberately declined to answer, not merely that she paused.
    const escalated = await conversationsWithOpenEscalations(supabase, heldIds)

    const todayISO = new Date().toISOString().slice(0, 10)

    for (const h of held.attention) {
      const datePassed = !!h.target_date && h.target_date < todayISO
      const hasDraft = withDrafts.has(h.id)
      const who = h.customer_name || h.customer_id || 'a customer'

      add({
        subjectType: SUBJECT_CONVERSATION,
        subjectId: h.id,
        conversationId: h.id,
        title: `${who} — ${(h.human_agent_reason ?? 'waiting on you').replace(/\s+/g, ' ').slice(0, 80)}`,
        // A date that has already gone by with no reply sent is the one hold
        // state that gets worse purely by sitting there.
        priority: datePassed ? 'critical' : 'decision',
        nextAction: hasDraft
          ? 'Draft ready — needs your approval'
          : escalated.has(h.id)
            ? 'Waiting on your call'
            : 'Waiting on your reply',
        // What re-earns attention: a new message from them, a new reason, a
        // draft appearing, the date lapsing. NOT the passage of time alone —
        // an item that has merely aged belongs in the unchanged bucket.
        fingerprintParts: [h.human_agent_reason, h.last_message_at, hasDraft, datePassed],
      })
    }

    // ── 2. Scheduled reminders ───────────────────────────────────────────
    // The owner asked to be reminded; until it fires, it is a thing they are
    // owed. Awareness tier: a reminder is a nudge, never a judgment call, and
    // must never be phrased as a question.
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

    // ── 3. Write ─────────────────────────────────────────────────────────
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

    // ── 4. Resolve what's gone ───────────────────────────────────────────
    // Only types this sync owns. An item recorded by a producer whose source
    // this function doesn't read must not be closed here just because it
    // wasn't in the candidate set.
    const owned = [SUBJECT_CONVERSATION, SUBJECT_REMINDER]
    const { data: openRows } = await supabase
      .from('caye_owner_attention')
      .select('subject_type, subject_id')
      .eq('workspace_id', workspaceId)
      .in('status', ['open', 'acknowledged', 'decided'])
      .in('subject_type', owned)

    const ownedSet = new Set(owned)
    for (const row of (openRows ?? []) as Array<{ subject_type: string; subject_id: string }>) {
      // Belt and braces with the .in() filter above. Resolving is
      // irreversible from the owner's point of view — the item silently stops
      // appearing — so the ownership check lives here too rather than only in
      // the query, where a later edit could quietly drop it.
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

/** Held conversations carrying a drafted reply awaiting approval. */
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

/** Held conversations with an escalation still open. */
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
