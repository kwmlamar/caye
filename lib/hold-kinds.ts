import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'
import { isAttentionHold, holdKindOf } from './hold-kinds-shared'
export { QUEUE_HOLD_KINDS, isQueueHold, isAttentionHold, holdKindOf, conversationNeedsFounder } from './hold-kinds-shared'

/**
 * Two different things share the `human_agent_enabled` flag, and conflating
 * them makes Caye nag about work nobody is waiting on.
 *
 * A REAL hold means the owner owes the next move: a guest asked something
 * Caye wouldn't answer alone, and that guest is waiting. Bimini's two open
 * holds are of this kind — a complaint from 2026-07-24 and a policy call
 * from 07-25.
 *
 * A QUEUE hold means Caye drafted cold outreach and parked it for batch
 * approval. Nobody is waiting; the operator processes these in one sitting
 * when it suits them. On 2026-08-07 the TropiTech Outreach workspace had 19
 * held threads and 18 were this kind.
 *
 * Before this split, every reader counted all 19 as "needs your call" —
 * get_held_queue, the morning digest, get_today_summary's held_items, and
 * stale-hold-sweep, which would chase the operator about a queue they were
 * deliberately letting fill up. That is decision 1 of
 * briefs/workspace-events-plan.md ("route on who owes the next move")
 * applied where the problem actually turned out to be.
 *
 * The distinction is already recorded — metadata.hold_kind is written by
 * create-outreach-leads and outreach-nudge-scan. Nothing new is stored here;
 * the readers were simply ignoring it.
 *
 * The pure predicates (QUEUE_HOLD_KINDS, isQueueHold, isAttentionHold,
 * holdKindOf, conversationNeedsFounder) now live in hold-kinds-shared.ts,
 * re-exported here, so client components can import them without pulling in
 * this file's Supabase-client-taking functions — see that file's doc
 * comment for why (2026-08-13 Inbox badge/filter consolidation).
 */

type SupabaseClient = ReturnType<typeof createServiceClient>

export interface AttentionHold {
  id: string
  customer_name: string | null
  customer_id: string | null
  channel_type: string
  human_agent_reason: string | null
  human_agent_marked_at: string | null
  last_message_preview: string | null
  last_message_at: string | null
  last_sender_type: string | null
  last_business_sender_kind: string | null
  target_date: string | null
}

interface RawHoldRow extends AttentionHold {
  metadata: unknown
}

// Generous relative to anything seen in production — real attention holds
// run single digits per workspace (Bimini: 2, TropiTech Outreach: 1 once
// the queue is excluded). Exists to bound worst case, not because it's
// expected to bite; if it ever does, that's a workspace with genuinely
// hundreds of unresolved holds and a much bigger problem than this cap.
const ATTENTION_HOLD_SCAN_CAP = 500

/**
 * Every held, non-archived conversation in a workspace that a person is
 * actually waiting on — human_agent_enabled=true with queue holds (drafted
 * cold outreach awaiting batch approval) filtered out.
 *
 * The single fetch-and-filter primitive behind every "how many/which things
 * need my call" surface: get_held_queue, get_today_summary, the morning
 * digest (both the held count and the oldest-aging-hold line),
 * stale-hold-sweep, and the founder dashboard's "Needs review" stat. Before
 * this existed, six call sites each hand-wrote the same
 * fetch-connected-accounts-then-fetch-held-conversations-then-filter
 * sequence — which is exactly the shape of duplication that let the queue
 * hold bug (and, separately, the founder-dashboard drift between the "Needs
 * review" stat and the Review tab) go unnoticed in some call sites while
 * fixed in others.
 *
 * Ordered oldest-held-first (nulls last) — the ordering every current
 * caller except the founder dashboard's plain count actually wants; a
 * caller that doesn't care about order (a count) is unaffected by it.
 *
 * founder/conversations (the paginated Review tab) does NOT use this — it
 * needs the raw pre-filter rows to anchor its keyset pagination cursor past
 * whatever queue holds got filtered out of a page, which this function's
 * return shape throws away by design. See that route for why forcing it
 * through this helper would be the wrong abstraction, not a missed one.
 */
export interface HeldSummary {
  /** Real holds — someone is waiting. */
  attention: AttentionHold[]
  /** Queue holds seen in the same scan — drafted outreach, nobody waiting.
   *  Exposed as a count only; callers that need the actual rows (e.g. to
   *  list them for batch approval) go through get_pending_quotes instead. */
  queuedCount: number
}

async function fetchHeldSummary(supabase: SupabaseClient, workspaceId: string): Promise<HeldSummary> {
  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', workspaceId)
  const accountIds = ((accounts ?? []) as { id: string }[]).map((a) => a.id)
  if (accountIds.length === 0) return { attention: [], queuedCount: 0 }

  const { data } = await supabase
    .from('unified_conversations')
    .select(
      'id, customer_name, customer_id, channel_type, human_agent_reason, human_agent_marked_at, last_message_preview, last_message_at, last_sender_type, last_business_sender_kind, target_date, metadata'
    )
    .in('connected_account_id', accountIds)
    .eq('is_archived', false)
    .eq('human_agent_enabled', true)
    .order('human_agent_marked_at', { ascending: true, nullsFirst: false })
    .limit(ATTENTION_HOLD_SCAN_CAP)

  const raw = (data ?? []) as RawHoldRow[]
  const attention = raw
    .filter((r) => isAttentionHold(holdKindOf(r.metadata)))
    .map(({ metadata: _metadata, ...rest }) => rest)

  return { attention, queuedCount: raw.length - attention.length }
}

/** Just the real holds — the common case for every caller except
 *  get_held_queue, which also wants queuedCount to report alongside them. */
export async function getAttentionHolds(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<AttentionHold[]> {
  return (await fetchHeldSummary(supabase, workspaceId)).attention
}

export async function getAttentionHoldCount(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<number> {
  return (await fetchHeldSummary(supabase, workspaceId)).attention.length
}

/** Real holds plus the queue count, in one scan — for get_held_queue. */
export async function getHeldSummary(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<HeldSummary> {
  return fetchHeldSummary(supabase, workspaceId)
}
