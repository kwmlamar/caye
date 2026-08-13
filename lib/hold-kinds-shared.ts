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
 * pingSummary/internal_context — already plain founder-readable prose. The
 * one thing worth trimming client- or server-side is the "Escalation
 * (category): " label prefix prepended for the row/hold reason
 * specifically — internal taxonomy, not worth the row width when the state
 * is already shown by a dot + label next to it. Was duplicated inline in
 * ConversationRow.tsx; centralized here once the People page needed the
 * exact same cleanup for the same field.
 */
export function cleanHoldReason(reason: string | null): string {
  if (!reason) return 'Needs your review'
  return reason.replace(/^Escalation \([a-z_]+\):\s*/i, '')
}
