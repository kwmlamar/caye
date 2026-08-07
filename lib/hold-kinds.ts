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
 */

/**
 * Hold kinds that represent drafted outreach awaiting batch approval.
 *
 * Single source of truth: send_outreach_batch gates on exactly this set (it
 * refuses to ship anything else), and the read layer must agree with it or a
 * thread could be hidden from the operator's queue while still being
 * batch-sendable, or vice versa.
 */
export const QUEUE_HOLD_KINDS = new Set(['outreach_first_touch', 'outreach_followup'])

export function isQueueHold(holdKind: unknown): boolean {
  return typeof holdKind === 'string' && QUEUE_HOLD_KINDS.has(holdKind)
}

/**
 * True when this held thread means a person is actually waiting on the
 * operator. Anything without a queue hold_kind counts as real — the default
 * is deliberately conservative, so a hold path that forgets to set hold_kind
 * surfaces as an attention item rather than vanishing into a queue nobody
 * checks.
 */
export function isAttentionHold(holdKind: unknown): boolean {
  return !isQueueHold(holdKind)
}

/** Reads hold_kind out of a conversation's metadata blob. */
export function holdKindOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const k = (metadata as Record<string, unknown>).hold_kind
  return typeof k === 'string' ? k : null
}
