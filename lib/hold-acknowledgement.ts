/**
 * A customer who is waiting on a human should not be left with silence merely
 * because the model omitted the optional acknowledgement tool argument.
 *
 * Non-customer mail is deliberately excluded: a newsletter or vendor pitch
 * does not become more useful because Caye replied to it.
 */
const NON_CUSTOMER_HOLD_REASON =
  /\b(?:not a customer message|newsletter|vendor(?:\s|$)|marketing|automated bounce|bounce)\b/i

const DEFAULT_HOLD_ACKNOWLEDGEMENT =
  'Thanks for reaching out — let me check on that and get back to you shortly.'

export function resolveHoldAcknowledgement(input: {
  acknowledgement?: string
  proposedReply?: string
  reason: string
}): string | undefined {
  const acknowledgement = input.acknowledgement?.trim()
  if (acknowledgement) return acknowledgement

  // A proposed reply means Caye understood a real request well enough to
  // draft for the owner. That is precisely the customer-facing hold shape
  // that needs an immediate acknowledgement.
  if (input.proposedReply?.trim() && !NON_CUSTOMER_HOLD_REASON.test(input.reason)) {
    return DEFAULT_HOLD_ACKNOWLEDGEMENT
  }

  return undefined
}
