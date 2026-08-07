import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export type HoldResolution = 'replied' | 'replied_then_corrected' | 'answered_by_operator' | 'resolved_no_reply'

export interface HoldEvent {
  conversationId: string
  customer: string | null
  channel: string
  markedAt: string | null
  stillHeld: boolean
  resolution: HoldResolution | null
}

export interface BookingEvent {
  customer: string | null
  bookingDate: string
  status: string
  event: 'created' | 'updated'
  at: string
}

export type EscalationEventStatus = 'opened' | 'resolved' | 'expired'

export interface EscalationEvent {
  conversationId: string | null
  category: string
  routeTo: string
  status: EscalationEventStatus
  at: string
}

export interface ChaseMessage {
  conversationId: string
  customer: string | null
  sentAt: string
}

export interface ActivitySince {
  cutoff: string
  holdEvents: HoldEvent[]
  bookingEvents: BookingEvent[]
  escalationEvents: EscalationEvent[]
  chaseMessages: ChaseMessage[]
}

export function isActivityEmpty(activity: ActivitySince): boolean {
  return (
    activity.holdEvents.length === 0 &&
    activity.bookingEvents.length === 0 &&
    activity.escalationEvents.length === 0 &&
    activity.chaseMessages.length === 0
  )
}

interface RawBookingRow {
  customer_name: string | null
  status: string
  booking_date: string
  created_at: string
  updated_at: string
}

interface RawConvRow {
  id: string
  customer_name: string | null
  channel_type: string
  human_agent_enabled: boolean
  human_agent_marked_at: string | null
}

interface RawFollowUpMsg {
  conversation_id: string
  sent_at: string
  metadata: Record<string, unknown> | null
}

interface RawEscalationRow {
  conversation_id: string | null
  category: string
  route_to: string
  created_at: string
  owner_responded_at: string | null
  expired_at: string | null
}

interface RawChaseMsg {
  conversation_id: string
  sent_at: string
}

/**
 * What actually happened after a hold was cleared, from the business
 * messages sent on that conversation since it was marked held. Mirrors
 * get_recent_activity's original classifyResolution — kept here since this
 * is now the one place that owns the query, with get_recent_activity
 * delegating to it (see getRecentActivity tool).
 */
function classifyResolution(markedAt: string | null, msgs: RawFollowUpMsg[]): HoldResolution {
  const after = msgs.filter((m) => !markedAt || m.sent_at > markedAt)
  if (after.length === 0) return 'resolved_no_reply'
  const hasCorrection = after.some((m) => (m.metadata as Record<string, unknown> | null)?.is_correction === true)
  if (hasCorrection) return 'replied_then_corrected'
  const cayeReplied = after.some((m) => (m.metadata as Record<string, unknown> | null)?.generated_by === 'caye')
  return cayeReplied ? 'replied' : 'answered_by_operator'
}

/**
 * Everything that changed in a workspace since `cutoff`: holds opened or
 * resolved, bookings created or updated, escalations opened/resolved/
 * expired, and customer messages on threads that are ALREADY held (a
 * "chase" — the thread's own state didn't change, but the customer is
 * still waiting and said so again).
 *
 * Built for two callers that need to agree on what "since X" means:
 *   - get_recent_activity (interactive "what happened?" tool)
 *   - the opportunity-scan cron's pre-LLM change-gate + delta context
 *     (2026-08-07 — see the comment on runOpportunityScan). A scan that
 *     finds isActivityEmpty(...) === true skips the agent turn entirely;
 *     Caye can't repeat a stale finding if she never runs.
 *
 * limit bounds each query independently (default 20) — a generous window
 * (get_recent_activity allows up to 168h) on a busy workspace could
 * otherwise return an unbounded result set.
 */
export async function getActivitySince(
  workspaceId: string,
  cutoff: string,
  opts?: { limit?: number }
): Promise<ActivitySince> {
  const supabase = createServiceClient()
  const limit = opts?.limit ?? 20

  const { data: bookings } = await supabase
    .from('bookings')
    .select('customer_name, status, booking_date, created_at, updated_at')
    .eq('user_id', workspaceId)
    .or(`created_at.gte.${cutoff},updated_at.gte.${cutoff}`)
    .order('updated_at', { ascending: false })
    .limit(limit)

  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', workspaceId)
  const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)

  let holds: RawConvRow[] = []
  let currentlyHeldIds: string[] = []
  if (accountIds.length > 0) {
    const { data: holdData } = await supabase
      .from('unified_conversations')
      .select('id, customer_name, channel_type, human_agent_enabled, human_agent_marked_at')
      .in('connected_account_id', accountIds)
      .gte('human_agent_marked_at', cutoff)
      .order('human_agent_marked_at', { ascending: false })
      .limit(limit)
    holds = (holdData ?? []) as RawConvRow[]

    const { data: heldData } = await supabase
      .from('unified_conversations')
      .select('id')
      .in('connected_account_id', accountIds)
      .eq('human_agent_enabled', true)
      .eq('is_archived', false)
    currentlyHeldIds = ((heldData ?? []) as { id: string }[]).map((c) => c.id)
  }

  // For every hold that's since been cleared, figure out what actually
  // happened — one batched query across all of them. is_internal=false
  // excludes the hold note Caye writes to herself when opening the hold.
  const resolvedConvIds = holds.filter((c) => !c.human_agent_enabled).map((c) => c.id)
  const followUpsByConv = new Map<string, RawFollowUpMsg[]>()
  if (resolvedConvIds.length > 0) {
    const earliestMarkedAt = holds.reduce<string>((min, c) => {
      if (!c.human_agent_marked_at) return min
      return !min || c.human_agent_marked_at < min ? c.human_agent_marked_at : min
    }, '')
    const { data: followUps } = await supabase
      .from('unified_messages')
      .select('conversation_id, sent_at, metadata')
      .in('conversation_id', resolvedConvIds)
      .eq('sender_type', 'business')
      .eq('is_internal', false)
      .gte('sent_at', earliestMarkedAt || cutoff)
      .order('sent_at', { ascending: true })
      .limit(100)

    for (const m of (followUps ?? []) as RawFollowUpMsg[]) {
      const list = followUpsByConv.get(m.conversation_id) ?? []
      list.push(m)
      followUpsByConv.set(m.conversation_id, list)
    }
  }

  const { data: escalations } = await supabase
    .from('caye_escalations')
    .select('conversation_id, category, route_to, created_at, owner_responded_at, expired_at')
    .eq('workspace_id', workspaceId)
    .or(
      `created_at.gte.${cutoff},owner_responded_at.gte.${cutoff},expired_at.gte.${cutoff}`
    )
    .order('created_at', { ascending: false })
    .limit(limit)

  const escalationEvents: EscalationEvent[] = []
  for (const e of (escalations ?? []) as RawEscalationRow[]) {
    // A row can independently qualify on more than one timestamp (e.g.
    // opened AND resolved within the same window on a fast-moving thread)
    // — emit one event per timestamp that actually falls in-window, most
    // recent state last, so a reader scanning top-to-bottom sees the
    // lifecycle in order.
    if (e.created_at >= cutoff) {
      escalationEvents.push({
        conversationId: e.conversation_id,
        category: e.category,
        routeTo: e.route_to,
        status: 'opened',
        at: e.created_at,
      })
    }
    if (e.expired_at && e.expired_at >= cutoff) {
      escalationEvents.push({
        conversationId: e.conversation_id,
        category: e.category,
        routeTo: e.route_to,
        status: 'expired',
        at: e.expired_at,
      })
    }
    if (e.owner_responded_at && e.owner_responded_at >= cutoff) {
      escalationEvents.push({
        conversationId: e.conversation_id,
        category: e.category,
        routeTo: e.route_to,
        status: 'resolved',
        at: e.owner_responded_at,
      })
    }
  }
  escalationEvents.sort((a, b) => (a.at < b.at ? 1 : -1))

  let chaseMessages: ChaseMessage[] = []
  if (currentlyHeldIds.length > 0) {
    const { data: chaseData } = await supabase
      .from('unified_messages')
      .select('conversation_id, sent_at')
      .in('conversation_id', currentlyHeldIds)
      .eq('sender_type', 'customer')
      .eq('is_internal', false)
      .gte('sent_at', cutoff)
      .order('sent_at', { ascending: false })
      .limit(limit)

    const nameByConv = new Map(holds.map((c) => [c.id, c.customer_name]))
    // holds only covers conversations marked in-window — for a chase on an
    // older hold (the common case) fall back to a second lookup rather
    // than a per-row round trip.
    const missingIds = [
      ...new Set(((chaseData ?? []) as RawChaseMsg[]).map((m) => m.conversation_id)),
    ].filter((id) => !nameByConv.has(id))
    if (missingIds.length > 0) {
      const { data: names } = await supabase
        .from('unified_conversations')
        .select('id, customer_name')
        .in('id', missingIds)
      for (const n of (names ?? []) as { id: string; customer_name: string | null }[]) {
        nameByConv.set(n.id, n.customer_name)
      }
    }

    chaseMessages = ((chaseData ?? []) as RawChaseMsg[]).map((m) => ({
      conversationId: m.conversation_id,
      customer: nameByConv.get(m.conversation_id) ?? null,
      sentAt: m.sent_at,
    }))
  }

  const bookingRows = (bookings ?? []) as RawBookingRow[]

  return {
    cutoff,
    holdEvents: holds.map((c) => ({
      conversationId: c.id,
      customer: c.customer_name,
      channel: c.channel_type,
      markedAt: c.human_agent_marked_at,
      stillHeld: c.human_agent_enabled,
      resolution: c.human_agent_enabled
        ? null
        : classifyResolution(c.human_agent_marked_at, followUpsByConv.get(c.id) ?? []),
    })),
    bookingEvents: bookingRows.map((b) => ({
      customer: b.customer_name,
      bookingDate: b.booking_date,
      status: b.status,
      event: b.created_at === b.updated_at ? 'created' : 'updated',
      at: b.updated_at,
    })),
    escalationEvents,
    chaseMessages,
  }
}
