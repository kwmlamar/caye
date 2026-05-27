/**
 * Pure detection logic for the "owner corrects Caye" pattern. Extracted
 * from the email-poll route so it can be unit tested without Supabase.
 *
 * The signal: Caye sends an auto-reply, no customer follow-up arrives,
 * and the owner sends their own Zoho reply on the same thread.
 * Karenda is essentially saying "what Caye said wasn't quite right —
 * here's what I'd say." It's the highest-confidence voice training
 * signal we can capture from her actual workflow (she doesn't use the
 * app, so we can't capture pre-send draft edits).
 *
 * IMPORTANT: a customer message between Caye's reply and the owner's
 * reply BREAKS the correction pattern — the owner is responding to the
 * new customer message, not overriding Caye. The caller is responsible
 * for passing the LAST message before the owner's reply (any sender).
 */

export interface PriorMessage {
  id: string
  sender_type: 'customer' | 'business'
  metadata: Record<string, unknown> | null
}

export interface CorrectionDetection {
  is_correction: boolean
  /** When is_correction is true, the channel_message_id of the Caye
   *  reply that the owner overrode. Null otherwise. */
  corrected_caye_message_id: string | null
}

/**
 * Decide whether the owner's incoming message is overriding a Caye
 * auto-reply. Pass the immediate predecessor message (or null if none).
 */
export function detectOwnerCorrection(prior: PriorMessage | null): CorrectionDetection {
  if (!prior) {
    return { is_correction: false, corrected_caye_message_id: null }
  }
  if (prior.sender_type !== 'business') {
    // Last message was from the customer — owner is responding to them,
    // not correcting Caye.
    return { is_correction: false, corrected_caye_message_id: null }
  }
  const generatedBy = prior.metadata?.generated_by
  if (generatedBy !== 'caye') {
    // Last message was a previous human/owner reply — not a correction.
    return { is_correction: false, corrected_caye_message_id: null }
  }
  // Use the channel_message_id when available (Caye auto-replies are
  // stored with synthetic 'caye_auto_*' IDs in some channels; the row's
  // id is the universal identifier). We expose the row id here.
  return {
    is_correction: true,
    corrected_caye_message_id: prior.id,
  }
}
