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
 * Which of two fundamentally different claims a piece of participation
 * evidence is being asked to support (PR #135 review, second finding — a
 * single fixed-size lookback window can't distinguish these; no window
 * size fixes that, only knowing which one applies does):
 *
 * 'initial' — the reported state is the subject's ORIGINAL one (nothing has
 *   transitioned since it was first observed). The operator's action may
 *   plausibly have CAUSED that state to first exist (e.g. Mrs. Max quoting
 *   Autumn is what led the customer to reply and the booking to be
 *   created a few minutes later) — a small PRE-state evidence window is
 *   legitimate here.
 *
 * 'post-transition' — the reported state is a real transition from a
 *   DIFFERENT prior state (a status flip, a payment landing, a date/time
 *   change). The operator cannot have knowledge of a fact that did not
 *   exist yet when they acted — evidence must be AT OR AFTER the moment
 *   the ledger recorded this new state. No pre-state window at all.
 *
 * decideOperatorNotification derives which mode applies from
 * caye_owner_attention.first_state_fingerprint vs the live state_fingerprint
 * — see its own comment — never from a timing heuristic.
 */
export type ParticipationEvidenceMode = 'initial' | 'post-transition'

/**
 * How far back of `sinceISO` an 'initial'-mode check still counts
 * participation as evidence — the small causal window described above.
 * Only ever applied in 'initial' mode; 'post-transition' mode uses
 * `sinceISO` itself as the cutoff, no buffer.
 *
 * 60 minutes comfortably covers real production lag: in the Autumn
 * incident, the operator's approved send (01:39:06) landed a few minutes
 * before the ledger recorded the booking's original state — ordinary
 * webhook/sync/processing latency, not a stale reference to old business.
 */
export const PARTICIPATION_LOOKBACK_MS = 60 * 60 * 1000

/**
 * True if an operator-approved, customer-facing send happened on this
 * conversation within the evidence window `mode` defines relative to
 * `sinceISO`:
 *   'initial'         — at or after (sinceISO - PARTICIPATION_LOOKBACK_MS)
 *   'post-transition' — at or after sinceISO, no earlier
 * Neither mode has an upper bound — participation any time after the
 * cutoff, including well after `sinceISO`, still counts.
 *
 * Never throws — a lookup failure means "no evidence found," which is the
 * conservative direction (falls through to a real notification rather than
 * silently suppressing one on a broken query).
 */
export async function hasOperatorParticipatedInConversation(
  conversationId: string,
  sinceISO: string,
  mode: ParticipationEvidenceMode
): Promise<boolean> {
  try {
    const supabase = createServiceClient()
    const cutoff =
      mode === 'initial' ? new Date(new Date(sinceISO).getTime() - PARTICIPATION_LOOKBACK_MS).toISOString() : sinceISO
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
