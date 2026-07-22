/**
 * Pure function that enforces "no autosend" for a workspace, independent
 * of whatever the LLM decided inside generateCayeAutoReply. Extracted so
 * it can be unit tested without pulling in server-only Anthropic/Supabase
 * deps — same pattern as inbound-classifier.ts / caye-identity-guard.ts.
 *
 * Why this exists as a hard gate rather than a prompt instruction (issue
 * #66): generateCayeAutoReply has three ways a message can ship without a
 * human seeing it first —
 *   - action: 'reply' ships decision.content directly.
 *   - action: 'escalate' ships decision.content immediately (vague,
 *     "let me check with the team" by default, but still autonomous).
 *   - action: 'hold' can carry an optional customerAcknowledgement that
 *     ships immediately even though the substantive reply is held.
 * A prompt instruction to "always hold_for_human" only prevents the model
 * from choosing 'reply'/'escalate' in the first place — it doesn't cover
 * a future prompt edit, a model that ignores it, or the acknowledgement
 * leak on the hold path. This gate is the backstop for all three,
 * regardless of workspace_kind or what tools were offered.
 *
 * Apply this INSIDE generateCayeAutoReply, before it returns — not at
 * webhook call sites. lib/whatsapp/escalation.ts's applyEscalation
 * collapses 'escalate' into a plain 'reply' at the webhook layer
 * specifically so the normal send path runs unchanged, so gating only at
 * call sites that check `action === 'escalate'` would already be too late.
 */

import type { CayeAutoReply } from './caye-reply'

export function applyAutosendGate(
  decision: CayeAutoReply,
  autosendEnabled: boolean
): CayeAutoReply {
  if (autosendEnabled) return decision

  if (decision.action === 'reply') {
    return {
      action: 'hold',
      reason: 'Autosend disabled for this workspace',
      note: 'Caye drafted a reply, but autosend is off for this workspace — review and send manually.',
      proposedReply: decision.content,
    }
  }

  if (decision.action === 'escalate') {
    return {
      action: 'hold',
      reason: `Autosend disabled for this workspace (would have escalated: ${decision.category})`,
      note: decision.internalContext,
      proposedReply: decision.content,
    }
  }

  // Already a hold — still strip any customer-facing acknowledgement, since
  // that ships immediately even on the hold path (receptionist-spec Q7).
  // Nothing reaches the customer without review on this workspace, full stop.
  if (decision.customerAcknowledgement) {
    const { customerAcknowledgement: _drop, ...rest } = decision
    return rest
  }

  return decision
}
