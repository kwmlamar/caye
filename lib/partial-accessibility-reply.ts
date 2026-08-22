import type { BusinessFactRow } from './business-facts'

const ACCESSIBILITY_INQUIRY =
  /\b(?:accessible|accessibility|limited mobility|wheelchair|mobility scooter|electric scooter|fold(?:able|ed) scooter)\b/i

/**
 * Produces a narrow, fact-backed partial reply when a guest asks an
 * accessibility question that also contains a vehicle-safety unknown.
 *
 * Caye may state only the accommodation facts the owner has recorded. It
 * never answers whether a specific chair/scooter fits, whether a vehicle has
 * a ramp/lift, or whether a transfer is needed; those remain for confirmation.
 */
export function partialAccessibilityReplyFor(
  body: string,
  subject: string | undefined,
  facts: readonly BusinessFactRow[]
): string | undefined {
  if (!ACCESSIBILITY_INQUIRY.test(`${subject ?? ''}\n${body}`)) return undefined

  const mobilityFact = facts.find((fact) =>
    /can accommodate guests with walking limitations|slower pace with reduced walking/i.test(fact.fact)
  )
  const tourFact = facts.find((fact) =>
    /wheelchair and mobility scooter accessibility is available on the .+? only\./i.test(fact.fact)
  )
  const tourMatch = tourFact?.fact.match(
    /wheelchair and mobility scooter accessibility is available on the (.+?) only\./i
  )
  const tour = tourMatch?.[1]?.trim()

  if (!mobilityFact || !tour) return undefined

  const mentionsScooter = /\b(?:scooter|wheelchair)\b/i.test(body)
  const unknown = mentionsScooter
    ? 'I’m confirming the vehicle fit and transfer requirements for the scooter before we confirm the arrangement.'
    : 'I’m confirming the vehicle and transfer details for your mobility needs before we confirm the arrangement.'

  return (
    `Thank you for sharing those details. We can accommodate guests with limited mobility on our ${tour}, ` +
    'which can be run at a slower pace with reduced walking. ' +
    unknown
  )
}
