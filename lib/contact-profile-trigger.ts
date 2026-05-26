/**
 * Pure trigger logic for the customer style profile refresher.
 * Extracted from contact-profile.ts so it can be unit tested without
 * pulling in Supabase / Anthropic.
 *
 * The refresh cadence balances responsiveness against API cost:
 * - First extraction at message 3 (enough signal to be meaningful)
 * - Then every 5 messages after that (8, 13, 18, ...)
 */

export const FIRST_EXTRACTION_AT = 3
export const REFRESH_EVERY = 5

/**
 * Should we re-extract the contact's style profile given a new total
 * count of inbound messages from them?
 */
export function shouldExtractContactProfile(newCount: number): boolean {
  if (newCount < FIRST_EXTRACTION_AT) return false
  if (newCount === FIRST_EXTRACTION_AT) return true
  return (newCount - FIRST_EXTRACTION_AT) % REFRESH_EVERY === 0
}
