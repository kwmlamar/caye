import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Deterministic, structural evidence that a human operator personally
 * handled a customer conversation — no LLM classification, no text
 * matching. channel-dispatch.ts already tags every customer-facing send it
 * makes with `metadata.operator_approved` (true for every path except
 * fully-autonomous outreach — see its own comment), so "an operator-
 * approved unified_messages row landed on this conversation" is already a
 * real, existing fact in the data, not new instrumentation.
 *
 * WHY THIS EXISTS (2026-08-26 Autumn McNeill incident)
 * Mrs. Max pulled Autumn's thread, drafted/edited/sent a reply herself, and
 * told Caye directly she'd handled it. A booking_created ping still fired
 * ~9.5h later ("Just booked — Autumn McNeill..."), because nothing in that
 * trigger's path had any way to know the operator had already been in that
 * exact conversation. This is the shared check that closes that gap for any
 * producer with a conversationId — see decideOperatorNotification's
 * operatorParticipationCheck input.
 */

/**
 * How far back of `sinceISO` to still count participation as evidence for
 * the state being evaluated. Bounded on purpose — the goal is "was the
 * operator just in this exact conversation around when this state came to
 * be," not "have they ever said anything here" (an operator's participation
 * from weeks ago, on an unrelated earlier matter in the same long-lived
 * conversation, must not silently cover a brand-new development).
 *
 * 60 minutes comfortably covers real production lag: in the Autumn
 * incident, the operator's approved send (01:39:06) landed ~6 minutes
 * before the booking row's own updated_at (01:45:06) — ordinary webhook/
 * sync latency, not a stale reference to old business.
 */
export const PARTICIPATION_LOOKBACK_MS = 60 * 60 * 1000

/**
 * True if an operator-approved, customer-facing send happened on this
 * conversation at or after (sinceISO - PARTICIPATION_LOOKBACK_MS). No upper
 * bound: participation any time after that point — including well after
 * `sinceISO` — still counts, since the caller is asking "has the operator
 * been here around this," not "did they act before a strict cutoff."
 *
 * Never throws — a lookup failure means "no evidence found," which is the
 * conservative direction (falls through to a real notification rather than
 * silently suppressing one on a broken query).
 */
export async function hasOperatorParticipatedInConversation(
  conversationId: string,
  sinceISO: string
): Promise<boolean> {
  try {
    const supabase = createServiceClient()
    const cutoff = new Date(new Date(sinceISO).getTime() - PARTICIPATION_LOOKBACK_MS).toISOString()
    // Filtered in JS rather than via a `metadata->>operator_approved` eq
    // filter — matches the established pattern for this same metadata
    // field elsewhere (lib/caye-agent/activity-since.ts's
    // classifyResolution), and keeps the boolean-vs-jsonb-text comparison
    // unambiguous.
    const { data, error } = await supabase
      .from('unified_messages')
      .select('id, metadata')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'business')
      .eq('is_internal', false)
      .gte('sent_at', cutoff)
      .limit(20)
    if (error) {
      console.error('[operator-participation] lookup failed:', error)
      return false
    }
    return (data ?? []).some((m) => (m.metadata as Record<string, unknown> | null)?.operator_approved === true)
  } catch (err) {
    console.error('[operator-participation] threw:', err)
    return false
  }
}
