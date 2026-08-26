import 'server-only'
import { createHash } from 'crypto'
import { createServiceClient } from '@/lib/supabase-server'
import type { InboundDigest } from '@/lib/inbound-digest'

/**
 * Shared owner-attention state. See
 * supabase/migrations/20260812b_caye_owner_attention.sql for why this table
 * exists; in one line: two composers described the same item to Mrs. Max 30
 * minutes apart and reached opposite conclusions, because neither could see
 * what the other had said.
 *
 * THE CONTRACT
 *   Producers  (recordEscalation, holds, quotes, reminders) call observe().
 *   Notifiers  (outbound worker, briefing crons) call markNotified() with
 *              the text they actually sent.
 *   Composers  (morning briefing, EOD, scans, back-office chat) call
 *              loadAttentionDelta() and speak from it.
 *
 * THE RULE THAT MATTERS: an item whose fingerprint has not changed since the
 * owner was last told about it is NOT news. Say "still open" or say nothing.
 * Never re-surface it as if it were new, and never claim nothing needs the
 * owner while it is open.
 */

export type AttentionPriority = 'critical' | 'decision' | 'awareness' | 'routine'
export type AttentionStatus = 'open' | 'acknowledged' | 'decided' | 'resolved' | 'dismissed'

/**
 * Subject types. IDENTITY IS THE THING THE OWNER ACTS ON, not the record that
 * happened to notice it.
 *
 * An escalation row, a held conversation, and a drafted reply awaiting
 * approval can all describe ONE thread. The owner experiences one item and
 * should see one line. So everything conversation-backed shares
 * SUBJECT_CONVERSATION keyed by conversation id, and the contributors raise
 * its priority instead of adding rows.
 *
 * Keying escalations on escalation id (as this briefly did) produced two
 * ledger rows for one thread the moment the sync also saw it as a hold —
 * which is the duplicate-record failure the unique index cannot catch,
 * because the two rows are genuinely distinct by (subject_type, subject_id).
 */
export const SUBJECT_CONVERSATION = 'conversation'
export const SUBJECT_REMINDER = 'reminder'

export interface AttentionItem {
  id: string
  workspaceId: string
  subjectType: string
  subjectId: string
  conversationId: string | null
  title: string
  priority: AttentionPriority
  status: AttentionStatus
  firstNotifiedAt: string | null
  lastNotifiedAt: string | null
  notifyCount: number
  lastNotifiedSummary: string | null
  acknowledgedAt: string | null
  decidedAt: string | null
  decision: string | null
  nextAction: string | null
  completedAt: string | null
  stateFingerprint: string | null
  notifiedFingerprint: string | null
  lastChangedAt: string
  digest: InboundDigest | null
  /** Is Caye actually waiting on the operator right now. Default true — most
   *  attention items exist BECAUSE Caye is blocked. */
  blockedOnOperator: boolean
  /** Could Caye finish this herself given her current tools/capabilities.
   *  When this is true and blockedOnOperator is false, the notification
   *  gate resolves the item instead of pinging. Default false. */
  resolvableAutonomously: boolean
  /** caye_outbound_queue.id of the last notification sent for this item —
   *  lets the gate look up wa_delivery_status (read receipts) without
   *  re-deriving which row it was. */
  lastNotificationQueueId: string | null
  /** caye_outbound_queue.id of a notification QUEUED for this item but not
   *  yet dispatched. The lifecycle this closes: not notified → notification
   *  IN FLIGHT → notified → acknowledged → resolved. While this is set (and
   *  the pointed-to row is still actually pending — see loadAttentionDelta),
   *  a composer must not independently narrate the item as unreported; a
   *  ping is already on the way. */
  pendingNotificationQueueId: string | null
  /** state_fingerprint as of the moment the OPERATOR demonstrated awareness
   *  of this item independent of anything Caye told them (e.g. they sent an
   *  operator-approved reply in the linked conversation themselves). Distinct
   *  from notifiedFingerprint, which only ever means "Caye said this" — see
   *  supabase/migrations/20260826e_owner_attention_operator_awareness.sql
   *  and decideOperatorNotification's SUPPRESS_OPERATOR_AWARE outcome. */
  operatorAwareFingerprint: string | null
  operatorAwareAt: string | null
  operatorAwareSummary: string | null
  /** state_fingerprint as it was the FIRST time this subject was ever
   *  observed — set once at insert, never overwritten by a later
   *  transition. `firstStateFingerprint === stateFingerprint` means the
   *  current state IS still the subject's original one (no transition has
   *  happened yet); anything else means it has moved on since. This is
   *  what lets a participation-evidence check distinguish "the operator's
   *  action could plausibly have caused this state to first exist" from
   *  "the operator's action predates a fact that didn't exist yet" — see
   *  supabase/migrations/20260826f_owner_attention_first_state_fingerprint.sql
   *  and decideOperatorNotification's evidence-mode logic. */
  firstStateFingerprint: string | null
}

/** Row shape as it comes back from Supabase. */
interface AttentionRow {
  id: string
  workspace_id: string
  subject_type: string
  subject_id: string
  conversation_id: string | null
  title: string
  priority: AttentionPriority
  status: AttentionStatus
  first_notified_at: string | null
  last_notified_at: string | null
  notify_count: number
  last_notified_summary: string | null
  acknowledged_at: string | null
  decided_at: string | null
  decision: string | null
  next_action: string | null
  completed_at: string | null
  state_fingerprint: string | null
  notified_fingerprint: string | null
  last_changed_at: string
  digest: InboundDigest | null
  blocked_on_operator?: boolean | null
  resolvable_autonomously?: boolean | null
  last_notification_queue_id?: string | null
  pending_notification_queue_id?: string | null
  operator_aware_fingerprint?: string | null
  operator_aware_at?: string | null
  operator_aware_summary?: string | null
  first_state_fingerprint?: string | null
}

function toItem(row: AttentionRow): AttentionItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    conversationId: row.conversation_id,
    title: row.title,
    priority: row.priority,
    status: row.status,
    firstNotifiedAt: row.first_notified_at,
    lastNotifiedAt: row.last_notified_at,
    notifyCount: row.notify_count ?? 0,
    lastNotifiedSummary: row.last_notified_summary,
    acknowledgedAt: row.acknowledged_at,
    decidedAt: row.decided_at,
    decision: row.decision,
    nextAction: row.next_action,
    completedAt: row.completed_at,
    stateFingerprint: row.state_fingerprint,
    notifiedFingerprint: row.notified_fingerprint,
    lastChangedAt: row.last_changed_at,
    digest: row.digest,
    blockedOnOperator: row.blocked_on_operator ?? true,
    resolvableAutonomously: row.resolvable_autonomously ?? false,
    lastNotificationQueueId: row.last_notification_queue_id ?? null,
    pendingNotificationQueueId: row.pending_notification_queue_id ?? null,
    operatorAwareFingerprint: row.operator_aware_fingerprint ?? null,
    operatorAwareAt: row.operator_aware_at ?? null,
    operatorAwareSummary: row.operator_aware_summary ?? null,
    firstStateFingerprint: row.first_state_fingerprint ?? null,
  }
}

/**
 * Stable hash of an item's meaningful state.
 *
 * "Meaningful" is the producer's call and it is load-bearing: include the
 * fields whose change should re-earn the owner's attention (the ask, the
 * date, the amount, the status) and leave out the ones that churn on their
 * own (timestamps, view counts). Getting this wrong in the noisy direction
 * turns the briefing back into a daily re-announcement of the same item.
 */
export function fingerprint(parts: unknown[]): string {
  return createHash('sha256')
    .update(parts.map((p) => (p == null ? '' : String(p))).join(' '))
    .digest('hex')
    .slice(0, 32)
}

/**
 * Record (or update) an item that may need the owner.
 *
 * Idempotent on (workspaceId, subjectType, subjectId) — observing the same
 * underlying item again updates the row rather than creating a second one.
 * `last_changed_at` only moves when the fingerprint actually changes, which
 * is what lets a composer distinguish "new development" from "I looked at it
 * again."
 *
 * Never throws: attention bookkeeping must not be able to block the ping it
 * is bookkeeping for.
 */
export async function observeAttentionItem(args: {
  workspaceId: string
  subjectType: string
  subjectId: string
  title: string
  priority: AttentionPriority
  conversationId?: string | null
  nextAction?: string | null
  digest?: InboundDigest | null
  /** Fields whose change should re-earn the owner's attention. */
  fingerprintParts?: unknown[]
  /** Is Caye actually waiting on the operator right now. Omit to leave
   *  unchanged on an existing row / default true on a new one. */
  blockedOnOperator?: boolean
  /** Could Caye finish this herself given her current tools. Omit to leave
   *  unchanged on an existing row / default false on a new one. */
  resolvableAutonomously?: boolean
}): Promise<AttentionItem | null> {
  try {
    const supabase = createServiceClient()
    const fp = args.fingerprintParts ? fingerprint(args.fingerprintParts) : null

    const { data: existing } = await supabase
      .from('caye_owner_attention')
      .select('*')
      .eq('workspace_id', args.workspaceId)
      .eq('subject_type', args.subjectType)
      .eq('subject_id', args.subjectId)
      .maybeSingle<AttentionRow>()

    const now = new Date().toISOString()

    if (!existing) {
      const { data, error } = await supabase
        .from('caye_owner_attention')
        .insert({
          workspace_id: args.workspaceId,
          subject_type: args.subjectType,
          subject_id: args.subjectId,
          conversation_id: args.conversationId ?? null,
          title: args.title,
          priority: args.priority,
          next_action: args.nextAction ?? null,
          digest: args.digest ?? null,
          state_fingerprint: fp,
          first_state_fingerprint: fp,
          last_changed_at: now,
          ...(args.blockedOnOperator !== undefined ? { blocked_on_operator: args.blockedOnOperator } : {}),
          ...(args.resolvableAutonomously !== undefined
            ? { resolvable_autonomously: args.resolvableAutonomously }
            : {}),
        })
        .select('*')
        .single<AttentionRow>()
      if (error || !data) {
        console.error('[owner-attention] insert failed:', error)
        return null
      }
      return toItem(data)
    }

    // A resolved item that genuinely changed comes back open; a resolved
    // item merely re-observed stays resolved. Without this, closing
    // something and then re-scanning would resurrect it every sweep.
    const changed = fp !== null && fp !== existing.state_fingerprint
    const status: AttentionStatus =
      changed && (existing.status === 'resolved' || existing.status === 'dismissed')
        ? 'open'
        : existing.status

    const { data, error } = await supabase
      .from('caye_owner_attention')
      .update({
        title: args.title,
        priority: args.priority,
        conversation_id: args.conversationId ?? existing.conversation_id,
        next_action: args.nextAction ?? existing.next_action,
        digest: args.digest ?? existing.digest,
        state_fingerprint: fp ?? existing.state_fingerprint,
        status,
        ...(changed ? { last_changed_at: now } : {}),
        // first_state_fingerprint is DELIBERATELY absent from this update —
        // the update branch never writes it, under any condition, ever
        // (PR #135 review, third finding). A row only gets one whose
        // legitimacy we can vouch for: the moment observeAttentionItem
        // FIRST inserts it (the insert branch above). For a row that
        // predates the 20260826f migration, first_state_fingerprint is
        // NULL and stays NULL for that row's entire remaining lifetime —
        // there is no later moment where "we don't know its true original
        // state" becomes "now we do." Writing ANY value here on a later
        // observation — even the state as it stood just before this
        // update — would convert a genuine transition into something that
        // reads as "provably still the original state," which is exactly
        // the false-initial-mode bug this column exists to prevent. A NULL
        // first_state_fingerprint permanently means "not provably initial"
        // for that row, which decideOperatorNotification correctly reads
        // as always 'post-transition' (the strict, no-pre-state-buffer
        // mode) — see its own comment.
        ...(args.blockedOnOperator !== undefined ? { blocked_on_operator: args.blockedOnOperator } : {}),
        ...(args.resolvableAutonomously !== undefined
          ? { resolvable_autonomously: args.resolvableAutonomously }
          : {}),
        updated_at: now,
      })
      .eq('id', existing.id)
      .select('*')
      .single<AttentionRow>()

    if (error || !data) {
      console.error('[owner-attention] update failed:', error)
      return null
    }
    return toItem(data)
  } catch (err) {
    console.error('[owner-attention] observe threw:', err)
    return null
  }
}

/**
 * Record that the owner was told about an item, and what they were told.
 *
 * Stamps notified_fingerprint with the state as of this telling — that is
 * the value loadAttentionDelta compares against to decide whether a later
 * mention would be news or repetition.
 */
export async function markAttentionNotified(args: {
  workspaceId: string
  subjectType: string
  subjectId: string
  summary: string
  /** caye_outbound_queue.id this notification was actually sent as — lets
   *  the gate later look up wa_delivery_status (read receipts) for this
   *  item without re-deriving which row it was. Omit when the send didn't
   *  go through the queue. */
  queueId?: string
}): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { data: existing } = await supabase
      .from('caye_owner_attention')
      .select('id, first_notified_at, notify_count, state_fingerprint')
      .eq('workspace_id', args.workspaceId)
      .eq('subject_type', args.subjectType)
      .eq('subject_id', args.subjectId)
      .maybeSingle<Pick<AttentionRow, 'id' | 'first_notified_at' | 'notify_count' | 'state_fingerprint'>>()

    if (!existing) return

    const now = new Date().toISOString()
    await supabase
      .from('caye_owner_attention')
      .update({
        first_notified_at: existing.first_notified_at ?? now,
        last_notified_at: now,
        notify_count: (existing.notify_count ?? 0) + 1,
        last_notified_summary: args.summary.slice(0, 2000),
        notified_fingerprint: existing.state_fingerprint,
        ...(args.queueId ? { last_notification_queue_id: args.queueId } : {}),
        // The item is no longer "in flight" once actually dispatched — this
        // is the primary clear path. loadAttentionDelta also self-heals
        // against a pointer left dangling by a cancelled/failed send (never
        // reaching this function), so a stuck flag can't permanently
        // suppress an item either way.
        pending_notification_queue_id: null,
        updated_at: now,
      })
      .eq('id', existing.id)
  } catch (err) {
    console.error('[owner-attention] markNotified threw:', err)
  }
}

/**
 * Record that the OPERATOR demonstrated awareness of this item independent
 * of anything Caye said — e.g. they personally sent an operator-approved
 * reply in the linked conversation. This is a different fact from
 * markAttentionNotified (which only ever means "Caye told them") and is
 * kept in its own columns for exactly that reason — see
 * supabase/migrations/20260826e_owner_attention_operator_awareness.sql.
 *
 * Stamps operator_aware_fingerprint with the CURRENT state_fingerprint, the
 * same way markAttentionNotified stamps notified_fingerprint — a later
 * caller compares its freshly-computed state_fingerprint against this value
 * to tell "operator still current on this" from "state moved on since they
 * last showed they knew" (decideOperatorNotification's
 * SUPPRESS_OPERATOR_AWARE path and loadAttentionDelta's
 * alreadyKnownToOperator bucket both do exactly this comparison).
 *
 * No-op if the item doesn't exist yet — same ordering contract as
 * markAttentionPending: the caller must observeAttentionItem() first.
 * Never throws.
 */
export async function recordOperatorAwareness(args: {
  workspaceId: string
  subjectType: string
  subjectId: string
  evidence: string
}): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { data: existing } = await supabase
      .from('caye_owner_attention')
      .select('id, state_fingerprint')
      .eq('workspace_id', args.workspaceId)
      .eq('subject_type', args.subjectType)
      .eq('subject_id', args.subjectId)
      .maybeSingle<Pick<AttentionRow, 'id' | 'state_fingerprint'>>()

    if (!existing) return

    const now = new Date().toISOString()
    await supabase
      .from('caye_owner_attention')
      .update({
        operator_aware_fingerprint: existing.state_fingerprint,
        operator_aware_at: now,
        operator_aware_summary: args.evidence.slice(0, 500),
        updated_at: now,
      })
      .eq('id', existing.id)
  } catch (err) {
    console.error('[owner-attention] recordOperatorAwareness threw:', err)
  }
}

/**
 * Record that a notification for this item has been QUEUED but not yet
 * dispatched — the "in flight" state between not-notified and notified.
 * Called by the producer right after a successful enqueueOutbound, with the
 * queue row's own id.
 *
 * No-op if the item doesn't exist yet (the producer should always call
 * observeAttentionItem first — same ordering every other producer already
 * follows) — never creates a row here, and never throws.
 */
export async function markAttentionPending(args: {
  workspaceId: string
  subjectType: string
  subjectId: string
  queueId: string
}): Promise<void> {
  try {
    await createServiceClient()
      .from('caye_owner_attention')
      .update({ pending_notification_queue_id: args.queueId, updated_at: new Date().toISOString() })
      .eq('workspace_id', args.workspaceId)
      .eq('subject_type', args.subjectType)
      .eq('subject_id', args.subjectId)
  } catch (err) {
    console.error('[owner-attention] markPending threw:', err)
  }
}

/**
 * Move an item's lifecycle forward. Resolving is what removes it from every
 * future briefing — the counterpart to observe().
 */
export async function setAttentionStatus(args: {
  workspaceId: string
  subjectType: string
  subjectId: string
  status: AttentionStatus
  decision?: string | null
  completed?: boolean
}): Promise<void> {
  try {
    const now = new Date().toISOString()
    const patch: Record<string, unknown> = {
      status: args.status,
      last_changed_at: now,
      updated_at: now,
    }
    if (args.status === 'acknowledged') patch.acknowledged_at = now
    if (args.status === 'decided') {
      patch.decided_at = now
      if (args.decision) patch.decision = args.decision
    }
    if (args.status === 'resolved' || args.completed) patch.completed_at = now

    await createServiceClient()
      .from('caye_owner_attention')
      .update(patch)
      .eq('workspace_id', args.workspaceId)
      .eq('subject_type', args.subjectType)
      .eq('subject_id', args.subjectId)
  } catch (err) {
    console.error('[owner-attention] setStatus threw:', err)
  }
}

/** Resolve every open attention item attached to a conversation. Called when
 *  a hold clears, so a handled thread stops being briefed about. */
export async function resolveAttentionForConversation(
  workspaceId: string,
  conversationId: string
): Promise<void> {
  try {
    const now = new Date().toISOString()
    await createServiceClient()
      .from('caye_owner_attention')
      .update({ status: 'resolved', completed_at: now, last_changed_at: now, updated_at: now })
      .eq('workspace_id', workspaceId)
      .eq('conversation_id', conversationId)
      .in('status', ['open', 'acknowledged', 'decided'])
  } catch (err) {
    console.error('[owner-attention] resolveForConversation threw:', err)
  }
}

export interface AttentionDelta {
  /** Open, never mentioned to the owner. The only genuinely new things. */
  unreported: AttentionItem[]
  /** Open, mentioned before, and something has changed since. Worth a line. */
  changed: AttentionItem[]
  /** Open, mentioned before, nothing has changed. Worth at most a count. */
  unchanged: AttentionItem[]
  /** Open, a notification is already QUEUED but not yet dispatched — a
   *  different producer already decided to tell the owner and the send just
   *  hasn't happened yet. Not unreported, not changed, not unchanged: don't
   *  independently narrate these, they're already spoken for (2026-08-13,
   *  closes the digest/escalation ordering hazard — see
   *  caye_owner_attention.pending_notification_queue_id). */
  inFlight: AttentionItem[]
  /** Open, Caye never told the operator, but the operator already
   *  demonstrated awareness of this EXACT current state themselves (e.g.
   *  they personally sent the reply). Not unreported — telling them would be
   *  redundant. Not changed/unchanged either, since Caye never notified in
   *  the first place. A composer must not narrate these as new, as needing
   *  a reply, or as "already on your radar" — the operator already knows;
   *  say nothing and keep owning whatever's still Caye's to do next. */
  alreadyKnownToOperator: AttentionItem[]
  /** Resolved since the timestamp given. Proof of work, never a to-do. */
  resolvedSince: AttentionItem[]
  /** True when nothing anywhere is open. Lets a composer say "you're clear"
   *  without having to re-derive it — and, critically, stops it saying that
   *  while something is still open. */
  allClear: boolean
}

/**
 * What has changed since the owner was last spoken to.
 *
 * This is the read every proactive composer must do before writing a word.
 * The buckets ARE the editorial decision: unreported gets named, changed
 * gets a delta, unchanged gets a count at most, resolved gets mentioned only
 * as reassurance.
 */
export async function loadAttentionDelta(args: {
  workspaceId: string
  /** Resolutions after this instant count as "since last time". Defaults to
   *  24h ago, which matches the daily briefing cadence. */
  since?: Date
}): Promise<AttentionDelta> {
  const empty: AttentionDelta = {
    unreported: [],
    changed: [],
    unchanged: [],
    inFlight: [],
    alreadyKnownToOperator: [],
    resolvedSince: [],
    allClear: true,
  }

  try {
    const supabase = createServiceClient()
    const since = args.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000)

    const { data, error } = await supabase
      .from('caye_owner_attention')
      .select('*')
      .eq('workspace_id', args.workspaceId)
      .in('status', ['open', 'acknowledged', 'decided', 'resolved'])
      .order('last_changed_at', { ascending: false })
      .limit(200)

    if (error || !data) {
      console.error('[owner-attention] delta read failed:', error)
      return empty
    }

    const items = (data as AttentionRow[]).map(toItem)

    // Self-healing liveness check: pending_notification_queue_id only means
    // "in flight" while the row it points at is still actually pending. A
    // send that later got cancelled/failed (mute, precondition, delivery
    // failure) never runs markAttentionNotified's clear — without this
    // check, that stale pointer would suppress the item as "already being
    // told about" forever. One batched query, not one per item.
    const pendingQueueIds = Array.from(
      new Set(items.map((i) => i.pendingNotificationQueueId).filter((id): id is string => id !== null))
    )
    const stillPendingIds = new Set<string>()
    if (pendingQueueIds.length > 0) {
      const { data: queueRows } = await supabase
        .from('caye_outbound_queue')
        .select('id, status')
        .in('id', pendingQueueIds)
        .eq('status', 'pending')
      for (const row of queueRows ?? []) stillPendingIds.add(row.id as string)
    }

    const delta: AttentionDelta = { ...empty, allClear: true }

    for (const item of items) {
      if (item.status === 'resolved' || item.status === 'dismissed') {
        if (item.completedAt && new Date(item.completedAt) >= since) {
          delta.resolvedSince.push(item)
        }
        continue
      }
      // Anything still open means the owner is not clear, regardless of
      // whether it is worth a line this morning. This single flag is what
      // makes "no new threads need your immediate attention" impossible to
      // emit while an escalation is unresolved.
      delta.allClear = false

      const operatorCurrentlyAware =
        item.operatorAwareFingerprint !== null && item.operatorAwareFingerprint === item.stateFingerprint

      const inFlight = item.pendingNotificationQueueId !== null && stillPendingIds.has(item.pendingNotificationQueueId)
      if (inFlight) delta.inFlight.push(item)
      else if (!item.lastNotifiedAt && operatorCurrentlyAware) delta.alreadyKnownToOperator.push(item)
      else if (!item.lastNotifiedAt) delta.unreported.push(item)
      else if (item.stateFingerprint !== item.notifiedFingerprint) delta.changed.push(item)
      else delta.unchanged.push(item)
    }

    return delta
  } catch (err) {
    console.error('[owner-attention] delta threw:', err)
    return empty
  }
}

/** Priority order for prose: the most pressing thing goes first. */
const PRIORITY_RANK: Record<AttentionPriority, number> = {
  critical: 0,
  decision: 1,
  awareness: 2,
  routine: 3,
}

/**
 * Render the delta as the factual block a composer's prompt reasons over.
 *
 * Deterministic on purpose — the model decides the wording, never which
 * bucket an item is in or whether the owner is clear. Those are facts, and
 * facts do not belong to the model.
 */
export function renderAttentionContext(delta: AttentionDelta): string {
  if (delta.allClear && delta.resolvedSince.length === 0) {
    return 'ATTENTION STATE: nothing is open. The owner is genuinely clear.'
  }

  const byRank = (a: AttentionItem, b: AttentionItem) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  // Priority is written as plain prose, never "[decision]". This block goes
  // into a system prompt, and a model handed a bracketed enum can echo it —
  // which is exactly the shape that reached Mrs. Max as "[operator_reminder]".
  // Never put the enum in front of it in the first place.
  const line = (i: AttentionItem) =>
    `  - ${i.title} (priority: ${i.priority})${i.nextAction ? ` — next: ${i.nextAction}` : ''}`
  /** The line plus what Caye last said about it. Attached to every
   *  already-told item: a composer that can see its own previous words can
   *  give a delta instead of a restatement, and cannot accidentally
   *  contradict them. Withholding it is what made the contradiction
   *  possible in the first place. */
  const lineWithHistory = (i: AttentionItem) =>
    `${line(i)}\n      last told: "${(i.lastNotifiedSummary ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)}"`

  const out: string[] = ['ATTENTION STATE']

  if (delta.inFlight.length > 0) {
    out.push(
      `NOTIFICATION ALREADY QUEUED (${delta.inFlight.length}) — a ping about these is on its way right now, sent by something else. Do NOT also announce them here, new or changed; you would be telling the owner twice about one thing.`
    )
    out.push(...[...delta.inFlight].sort(byRank).map(line))
  }
  if (delta.unreported.length > 0) {
    out.push('NEW — the owner has never been told about these. Name them.')
    out.push(...[...delta.unreported].sort(byRank).map(line))
  }
  if (delta.alreadyKnownToOperator.length > 0) {
    out.push(
      `ALREADY KNOWN TO THE OPERATOR (${delta.alreadyKnownToOperator.length}) — Caye never told them, but they demonstrated they already know (they handled it themselves). Do NOT name these, do NOT say they're "on your radar" or "resolved" or "nothing further" — mentioning a non-event IS the interruption. Say nothing about them; keep owning whatever's still yours to do next.`
    )
    out.push(...[...delta.alreadyKnownToOperator].sort(byRank).map(line))
  }
  if (delta.changed.length > 0) {
    out.push('CHANGED — already told, but something moved. Give the delta only.')
    out.push(...[...delta.changed].sort(byRank).map(lineWithHistory))
  }
  if (delta.unchanged.length > 0) {
    out.push(
      `ALREADY TOLD, NOTHING CHANGED (${delta.unchanged.length}) — do NOT re-explain or re-raise as new. A count, or "still open", or silence.`
    )
    out.push(...[...delta.unchanged].sort(byRank).map(lineWithHistory))
  }
  if (delta.resolvedSince.length > 0) {
    out.push('RESOLVED since last time — never present as outstanding.')
    out.push(...delta.resolvedSince.map((i) => `  - ${i.title}`))
  }
  if (!delta.allClear) {
    out.push(
      'The owner is NOT clear. Do not say "nothing needs your attention" or anything equivalent.'
    )
  }

  return out.join('\n')
}
