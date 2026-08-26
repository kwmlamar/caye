/**
 * The queue-hold vs attention-hold split, and the single "does this
 * conversation need the founder" predicate built from it — pulled out of
 * hold-kinds.ts so client components (the Inbox conversation row, the
 * thread header pill) can import the exact same semantics the server-side
 * Review tab query and every other "needs your call" reader already use,
 * without pulling in hold-kinds.ts's Supabase-client-taking functions
 * (which is why that file is 'server-only' and this one isn't).
 *
 * hold-kinds.ts re-exports everything here, so existing server-side
 * imports of isAttentionHold/holdKindOf/etc. from '@/lib/hold-kinds' are
 * unaffected — this is a split, not a move.
 *
 * WHY THIS EXISTS (2026-08-13 Inbox audit)
 * The Review tab query (/api/founder/conversations) already filtered on
 * isAttentionHold(holdKindOf(metadata)) — queued cold-outreach follow-ups
 * awaiting batch approval correctly don't count as "needs you" there. But
 * ConversationRow (the row badge in the list) and the thread header pill
 * both just checked human_agent_enabled directly, with no hold_kind check
 * at all. Result: a queued outreach follow-up rendered a gold "Needs you"
 * badge in the list that then didn't appear when the Needs You tab was
 * selected — two different definitions of the same claimed state. This
 * module is the fix: one predicate, imported everywhere that state is
 * decided.
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
 * Hold kinds for inbound Caye confidently classified as business noise —
 * newsletters, mass-mailer blasts, automated notifications. No customer
 * question was actually asked, so there is no decision for the owner to
 * make. Held (so Caye doesn't reply into it and it stays visible/auditable
 * in the inbox) but never an attention item.
 *
 * 2026-08-26 (owner-attention audit): before this existed, every one of
 * these holds set the same `human_agent_enabled` flag a real hold does,
 * which is what put Kelsey Tonner's newsletter blast simultaneously in the
 * inbox as "held automatically" and in the owner's Needs You queue as
 * "waiting for you" — the flag meant two different things and nothing
 * distinguished them at read time. This is a companion to QUEUE_HOLD_KINDS
 * (a different reason the same flag doesn't mean "a person is waiting"),
 * not a replacement for it — see isAttentionHold below.
 */
export const NON_ACTIONABLE_HOLD_KINDS = new Set(['newsletter'])

export function isNonActionableHold(holdKind: unknown): boolean {
  return typeof holdKind === 'string' && NON_ACTIONABLE_HOLD_KINDS.has(holdKind)
}

/**
 * Hold kinds for an escalation Caye routed to the founder only
 * (`caye_escalations.route_to === 'founder'` — a tooling/product gap the
 * *workspace owner* has no way to act on, per escalate_to_team's own
 * category contract: "gap ... The operator can't fix this."). The founder
 * still gets pinged and sees it in their own dashboard via
 * `caye_escalations.route_to` directly; this only keeps it out of the
 * workspace owner's Needs You surface, which is the thing that was
 * misleading them.
 */
export const FOUNDER_ONLY_HOLD_KINDS = new Set(['founder_gap'])

export function isFounderOnlyHold(holdKind: unknown): boolean {
  return typeof holdKind === 'string' && FOUNDER_ONLY_HOLD_KINDS.has(holdKind)
}

/**
 * True when this held thread means the WORKSPACE OWNER is actually waiting
 * on / owed something. Anything without a recognized non-attention hold_kind
 * counts as real — the default is deliberately conservative, so a hold path
 * that forgets to set hold_kind surfaces as an attention item rather than
 * vanishing into a queue nobody checks.
 *
 * Three different reasons a hold might NOT be an attention item, kept as
 * separate named sets rather than one grab-bag: a queue hold is drafted
 * outbound nobody is waiting on either way; a non-actionable hold is
 * confidently-classified noise with no question attached; a founder-only
 * hold has a real open question, just not one this owner can answer. Same
 * treatment here, different reasons — worth keeping legible for whoever
 * reads this next.
 */
export function isAttentionHold(holdKind: unknown): boolean {
  return !isQueueHold(holdKind) && !isNonActionableHold(holdKind) && !isFounderOnlyHold(holdKind)
}

/** Reads hold_kind out of a conversation's metadata blob. */
export function holdKindOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const k = (metadata as Record<string, unknown>).hold_kind
  return typeof k === 'string' ? k : null
}

/**
 * THE canonical "this conversation needs the founder" predicate. Every
 * surface that shows a Needs You badge, filters a Needs You list, or counts
 * a Needs You total should call this rather than re-deriving it from
 * human_agent_enabled directly — that field alone doesn't distinguish a
 * real hold from a queued batch-approval draft.
 */
export function conversationNeedsFounder(c: { human_agent_enabled: boolean; metadata?: unknown }): boolean {
  return c.human_agent_enabled && isAttentionHold(holdKindOf(c.metadata))
}

/**
 * human_agent_reason is built server-side (lib/whatsapp/escalation.ts) from
 * pingSummary/internal_context — plain founder-readable prose. It no longer
 * gets an "Escalation (category): " prefix written at the source (CAY-12 —
 * that prefix put a raw routing enum like `sensitive` in front of every
 * escalation reason, and this column is read unstripped by several surfaces,
 * not just the two below). This strip stays as a backstop for rows written
 * before that fix. Was duplicated inline in ConversationRow.tsx; centralized
 * here once the People page needed the exact same cleanup for the same field.
 */
export function cleanHoldReason(reason: string | null): string {
  if (!reason) return 'Needs your review'
  return reason.replace(/^Escalation \([a-z_]+\):\s*/i, '')
}
