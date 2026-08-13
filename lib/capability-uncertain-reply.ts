/**
 * Certain related requests are useful to qualify before the owner has
 * confirmed that the business can actually fulfill them. This deliberately
 * avoids saying the service is available, or that Caye can arrange it.
 */
const TRANSPORT_REQUEST =
  /\b(?:transportation|transport|airport (?:pickup|transfer)|vip (?:service|pickup|meet(?:\s|-)and(?:\s|-)greet))\b/i

export const TRANSPORT_CAPABILITY_REPLY =
  "Thanks for reaching out. Let me check on transportation availability for your arrival. " +
  "To make sure we look into the right option, could you share your arrival time, whether you'll be arriving by ferry or plane, and the name of your accommodation? " +
  "We'll follow up once we've confirmed what's available."

export const TRANSPORT_CAPABILITY_OWNER_NOTE =
  'Confirm whether transportation is available and price the right option after the customer provides arrival details.'

export function capabilityUncertainReplyFor(body: string, subject: string = ''): string | undefined {
  return TRANSPORT_REQUEST.test(`${subject}\n${body}`)
    ? TRANSPORT_CAPABILITY_REPLY
    : undefined
}
