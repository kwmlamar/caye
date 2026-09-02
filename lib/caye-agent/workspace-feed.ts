import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getChannelState, SLOT_LABEL, slotForChannelType } from '@/lib/channels/slots'

/**
 * The read layer over workspace_events.
 *
 * The table stores facts. This file holds the *policy* — which facts are
 * worth telling an operator unprompted — deliberately in one place so it can
 * be tuned without a migration. See briefs/workspace-events-plan.md decision 3.
 */

export interface FeedEvent {
  id: number
  at: string
  type: string
  actorKind: string
  isFailure: boolean
  conversationId: string | null
  customer: string | null
  channel: string | null
  detail: Record<string, unknown>
}

export interface Coverage {
  /** Channels actually receiving right now. */
  live: string[]
  /** Withheld on purpose — read the reason, never offer these. */
  gated: { channel: string; reason: string }[]
  /** Not connected and worth offering. */
  missing: string[]
  /** False means Caye is receiving nothing at all. That's urgent. */
  isLive: boolean
  /** Last time anything arrived on each live channel. Null = never. */
  lastReceived: Record<string, string | null>
}

export interface WorkspaceFeed {
  windowHours: number
  events: FeedEvent[]
  /** True when nothing reportable happened in the window. */
  quiet: boolean
  coverage: Coverage
}

/**
 * Decision 3, as one function.
 *
 * Reportable = the outside world did something, OR something that was
 * supposed to happen didn't. Everything Caye or an operator did on purpose
 * and successfully is recorded but silent — she'll answer if asked, she
 * never opens with it.
 *
 * A failed thing is reportable regardless of who caused it: a cron that
 * didn't run is the highest-priority event in the system, because it means
 * this feed is lying about everything else.
 */
export function isReportable(e: { actorKind: string; isFailure: boolean }): boolean {
  return e.actorKind === 'outside' || e.isFailure
}

/**
 * The same rule expressed as a PostgREST `.or()` filter, so the database
 * does not ship rows the limit would then waste. It must stay in agreement
 * with isReportable above — the TS predicate is re-applied to whatever comes
 * back, so if the two ever disagree the conservative one wins and the
 * mismatch shows up as a short result rather than as noise in an operator's
 * digest. Change both or neither.
 */
const REPORTABLE_SQL_FILTER = 'actor_kind.eq.outside,is_failure.eq.true'

/**
 * A bounce is not a person writing in.
 *
 * Delivery failures arrive through the same inbound path as real replies —
 * sender_type='customer', from mailer-daemon — so on 2026-08-06 the three
 * most recent "inbound messages" on TropiTech Outreach were one real reply
 * and two bounces. Answering "who was the last person to email me?" with
 * "mailer-daemon@googlemail.com" is its own kind of wrong.
 *
 * They are still worth surfacing: a bounce means a lead is unreachable and
 * the address should stop being retried. So they are reclassified as
 * failures rather than hidden — reported as what they are, not as guest
 * activity.
 */
export function isBounceAddress(address: string | null | undefined): boolean {
  if (!address) return false
  const a = address.toLowerCase()
  return (
    a.startsWith('mailer-daemon@') ||
    a.startsWith('postmaster@') ||
    a.startsWith('no-reply@') ||
    a.startsWith('noreply@') ||
    a.includes('mailer-daemon')
  )
}

interface RawEvent {
  id: number
  occurred_at: string
  type: string
  actor_kind: string
  is_failure: boolean
  conversation_id: string | null
  payload: Record<string, unknown> | null
}

/**
 * Message and hold events carry a conversation_id but not the customer's
 * name — that lives on the conversation and can change. Resolved at read
 * time in one batched lookup so the stored event never goes stale.
 */
interface ConvContext {
  customer: string | null
  /** Raw handle (email address / phone / PSID) — needed for bounce detection. */
  address: string | null
  channel: string
}

async function attachConversationContext(
  supabase: ReturnType<typeof createServiceClient>,
  rows: RawEvent[]
): Promise<Map<string, ConvContext>> {
  const ids = [...new Set(rows.map((r) => r.conversation_id).filter((v): v is string => !!v))]
  const out = new Map<string, ConvContext>()
  if (ids.length === 0) return out

  const { data } = await supabase
    .from('unified_conversations')
    .select('id, customer_name, customer_id, channel_type')
    .in('id', ids)

  for (const c of (data ?? []) as {
    id: string
    customer_name: string | null
    customer_id: string | null
    channel_type: string
  }[]) {
    out.set(c.id, {
      customer: c.customer_name || c.customer_id,
      address: c.customer_id,
      channel: c.channel_type,
    })
  }
  return out
}

function toFeedEvent(r: RawEvent, ctx: Map<string, ConvContext>): FeedEvent {
  const conv = r.conversation_id ? ctx.get(r.conversation_id) : undefined
  const payload = r.payload ?? {}
  // A bounce arrives on the inbound path but is a delivery failure, not a
  // guest. Reclassified here rather than hidden — an unreachable lead is
  // worth telling someone about, just not as "somebody wrote in".
  const bounced = r.type === 'message.inbound' && isBounceAddress(conv?.address)
  return {
    id: r.id,
    at: r.occurred_at,
    type: bounced ? 'message.bounced' : r.type,
    actorKind: r.actor_kind,
    isFailure: r.is_failure || bounced,
    conversationId: r.conversation_id,
    customer: conv?.customer ?? (payload.customer as string | null) ?? null,
    channel: conv?.channel ?? (payload.channel as string | null) ?? null,
    detail: payload,
  }
}

/**
 * Domain events have two clocks with different meanings. `occurred_at` is the
 * source system's chronology and must remain untouched. `payload.observed_at`
 * is when Caye learned about that source event and is therefore the freshness
 * clock for outage catch-up. Ordinary workspace events still use occurred_at.
 */
function feedFreshness(r: RawEvent): string {
  if (r.type.startsWith('domain.') && typeof r.payload?.observed_at === 'string') {
    return r.payload.observed_at
  }
  return r.occurred_at
}

/**
 * What Caye can and cannot see, as data rather than as a prompt instruction.
 *
 * This exists because of the 2026-08-07 failure: asked who last emailed,
 * Caye said nothing had come in for a week and guessed the email channel
 * might not be connected. The channel had been live for two weeks and 34
 * messages had arrived. The problem was not that she was ignorant — it was
 * that she was ignorant *without saying so*, and volunteered a theory
 * instead of checking.
 *
 * Returning this on every feed response means she cannot report absence
 * without having the coverage picture in front of her. The prompt is not
 * trusted to enforce that: the model ignored its own ban list 7 times in 31
 * (2026-08-01).
 */
export async function getCoverage(workspaceId: string): Promise<Coverage> {
  const supabase = createServiceClient()
  const state = await getChannelState(supabase, workspaceId)

  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id, channel_type')
    .eq('user_id', workspaceId)
    .eq('is_active', true)

  const rows = (accounts ?? []) as { id: string; channel_type: string }[]
  const lastReceived: Record<string, string | null> = {}
  for (const slot of state.connected) lastReceived[SLOT_LABEL[slot]] = null

  if (rows.length > 0) {
    const { data: convs } = await supabase
      .from('unified_conversations')
      .select('channel_type, last_message_at')
      .in(
        'connected_account_id',
        rows.map((r) => r.id)
      )
      .not('last_message_at', 'is', null)
      .order('last_message_at', { ascending: false })
      .limit(200)

    for (const c of (convs ?? []) as { channel_type: string; last_message_at: string }[]) {
      const slot = slotForChannelType(c.channel_type)
      if (!slot) continue
      const label = SLOT_LABEL[slot]
      // Rows arrive newest-first, so the first hit per label wins.
      if (lastReceived[label] == null) lastReceived[label] = c.last_message_at
    }
  }

  return {
    live: state.connected.map((s) => SLOT_LABEL[s]),
    gated: state.gated.map((g) => ({ channel: SLOT_LABEL[g.slot], reason: g.reason })),
    missing: state.missing.map((s) => SLOT_LABEL[s]),
    isLive: state.isLive,
    lastReceived,
  }
}

/**
 * Reportable activity in a window, newest first, plus coverage.
 *
 * `quiet` is a first-class result, not an empty array to be interpreted.
 * "Nothing happened" and "I can't see anything" are different answers and
 * the caller must be able to tell them apart — coverage is what separates
 * them.
 *
 * External domain events are the one exception to occurred_at freshness. A
 * source event may be old but first observed after an outage today. The second
 * query admits that bounded backlog by observed_at, orders by that same clock
 * before applying its limit, then the two paths are deduplicated by event id.
 */
export async function getWorkspaceFeed(
  workspaceId: string,
  opts?: { hours?: number; limit?: number }
): Promise<WorkspaceFeed> {
  const supabase = createServiceClient()
  const hours = Math.min(opts?.hours ?? 24, 24 * 30)
  const limit = opts?.limit ?? 30
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
  const select = 'id, occurred_at, type, actor_kind, is_failure, conversation_id, payload'

  const [{ data: ordinary }, { data: domainObserved }] = await Promise.all([
    supabase
      .from('workspace_events')
      .select(select)
      .eq('workspace_id', workspaceId)
      .gte('occurred_at', cutoff)
      .or(REPORTABLE_SQL_FILTER)
      .order('occurred_at', { ascending: false })
      .limit(limit),
    supabase
      .from('workspace_events')
      .select(select)
      .eq('workspace_id', workspaceId)
      .like('type', 'domain.%')
      .gte('payload->>observed_at', cutoff)
      .or(REPORTABLE_SQL_FILTER)
      .order('payload->>observed_at', { ascending: false })
      .limit(limit),
  ])

  const byId = new Map<number, RawEvent>()
  for (const row of [
    ...((ordinary ?? []) as RawEvent[]),
    ...((domainObserved ?? []) as RawEvent[]),
  ]) {
    byId.set(row.id, row)
  }

  const rows = [...byId.values()]
    .sort((a, b) => feedFreshness(b).localeCompare(feedFreshness(a)))
    .slice(0, limit)

  const ctx = await attachConversationContext(supabase, rows)
  const events = rows
    .map((r) => toFeedEvent(r, ctx))
    // Re-applied deliberately: isReportable is the definition, the SQL
    // filter is an optimisation. If they ever disagree, the definition wins.
    .filter(isReportable)
  const coverage = await getCoverage(workspaceId)

  return { windowHours: hours, events, quiet: events.length === 0, coverage }
}

export interface InboundThread {
  conversationId: string | null
  customer: string | null
  channel: string | null
  at: string
  preview: string | null
}

/**
 * The most recent people to write in, newest first, one row per thread —
 * with NO time window.
 *
 * Separate from getWorkspaceFeed on purpose. "What happened today?" and
 * "who was the last person to email me?" are different questions, and
 * answering the second with a windowed feed reproduces the original bug one
 * step removed: if the last inbound was 30 hours ago, a 24-hour window is
 * empty and Caye says "nothing came in" again, just as wrongly.
 *
 * A lookup that reaches back as far as it needs to cannot fail that way.
 */
export async function getRecentInbound(
  workspaceId: string,
  opts?: { limit?: number }
): Promise<{ threads: InboundThread[]; bounces: number; coverage: Coverage }> {
  const supabase = createServiceClient()
  const limit = opts?.limit ?? 10

  // Over-fetch: several events can share a thread and collapse to one row.
  const { data } = await supabase
    .from('workspace_events')
    .select('id, occurred_at, type, actor_kind, is_failure, conversation_id, payload')
    .eq('workspace_id', workspaceId)
    .eq('type', 'message.inbound')
    .order('occurred_at', { ascending: false })
    .limit(limit * 5)

  const rows = (data ?? []) as RawEvent[]
  const ctx = await attachConversationContext(supabase, rows)

  const seen = new Set<string>()
  const threads: InboundThread[] = []
  let bounces = 0
  for (const r of rows) {
    const key = r.conversation_id ?? `evt:${r.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const conv = r.conversation_id ? ctx.get(r.conversation_id) : undefined

    // Bounces are counted, not listed. This function answers "who wrote in",
    // and mailer-daemon is not an answer to that.
    if (isBounceAddress(conv?.address)) {
      bounces++
      continue
    }

    threads.push({
      conversationId: r.conversation_id,
      customer: conv?.customer ?? null,
      channel: conv?.channel ?? null,
      at: r.occurred_at,
      preview: (r.payload?.preview as string | null) ?? null,
    })
    if (threads.length >= limit) break
  }

  return { threads, bounces, coverage: await getCoverage(workspaceId) }
}
