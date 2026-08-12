/**
 * When may an owner-taught standing rule stand down?
 *
 * WHY THIS EXISTS (2026-08-11)
 * Karenda taught Caye one rule about her flagship tour: any mention of the
 * Full Bimini Experience goes to her. At the time that was right — Caye had no
 * deterministic way to know that the tour only runs Sundays for groups of six,
 * or that it needs three guests to depart, so any answer she gave was a guess.
 *
 * The rule has fired six times. Every one was an ordinary website intake form:
 *
 *   Name: Juli King | Guests: 2 | Date: Sunday, June 7 | Tour: Full Bimini Experience
 *   Name: Christina Masters | Guests: 2 | ... | Tour: Full Bimini Experience
 *   Name: Kenneth Cal | Guests: 8 | Wed 8/26 | Tour: Full Bimini Experience
 *
 * Six for six, Karenda then hand-dictated the reply over WhatsApp. On her most
 * common inbound, for her flagship product, Caye is a forwarding address.
 *
 * What changed since she taught the rule is that the two things it protected
 * against are now enforced in code: service_availability_rules decides the day
 * and the party size (2026-08-10), and every Full Bimini tier is
 * owner_confirmed pricing she set herself.
 *
 * So the rule now stands down in exactly one situation — when there is nothing
 * left to decide. Every fact needed to answer must be known deterministically,
 * from the catalog and her own rules, with no inference:
 *
 *   - the tour is matched to the catalog with HIGH confidence
 *   - the enquiry states a date
 *   - the enquiry states a party size
 *   - the availability rules return a clean `available` for that day and size
 *   - a pricing tier resolves without ambiguity
 *   - that tier is owner_confirmed, not seeded
 *
 * Miss any one and the rule fires exactly as before. This is deliberately not
 * "Caye is now confident enough" — that is a judgement, and judgement is what
 * the owner reserved. It is "there is no question here that Karenda has not
 * already answered in writing."
 */

export type MatchConfidence = 'high' | 'medium' | 'low' | 'none'
export type AvailabilityStatus = 'available' | 'unavailable' | 'available_below_minimum'

export interface StandDownFacts {
  /** Catalog match confidence for the tour named in the enquiry. */
  serviceMatchConfidence: MatchConfidence | null
  /** Date the customer asked for, if the enquiry states one. */
  dateISO: string | null
  /** Party size the customer stated, if any. */
  partySize: number | null
  /** Verdict from evaluateServiceAvailability, or null when no rules exist. */
  availabilityStatus: AvailabilityStatus | null
  /** True when resolveTier returned a price rather than holding. */
  tierResolved: boolean
  /** True when that tier's price came from the owner, not a seed. */
  tierOwnerConfirmed: boolean
}

export type StandDownVerdict =
  | { standDown: true; reason: string }
  | { standDown: false; reason: string }

/**
 * Decide whether the matched rule can be skipped for this specific enquiry.
 *
 * Fails toward escalating. Every unknown is a reason to involve the owner, and
 * the cost of the two outcomes is not symmetric: an unnecessary escalation
 * wastes a minute of Karenda's time, while a wrong autonomous quote on her
 * flagship tour is a price she has to honour or walk back with a guest.
 */
export function canStandDown(facts: StandDownFacts): StandDownVerdict {
  if (facts.serviceMatchConfidence !== 'high') {
    return {
      standDown: false,
      reason: `service match is ${facts.serviceMatchConfidence ?? 'absent'}, not high`,
    }
  }
  if (!facts.dateISO) {
    return { standDown: false, reason: 'enquiry states no date' }
  }
  if (facts.partySize == null) {
    return { standDown: false, reason: 'enquiry states no party size' }
  }

  // No availability rules at all means nobody has told us the tour is safe to
  // sell on an arbitrary day. That is an unknown, not a green light — the
  // absence of a rule is the absence of information.
  if (facts.availabilityStatus === null) {
    return { standDown: false, reason: 'no availability rules defined for this service' }
  }
  if (facts.availabilityStatus !== 'available') {
    return {
      standDown: false,
      reason: `availability is ${facts.availabilityStatus}, which needs the owner`,
    }
  }

  if (!facts.tierResolved) {
    return { standDown: false, reason: 'no unambiguous pricing tier for this party size' }
  }
  if (!facts.tierOwnerConfirmed) {
    return { standDown: false, reason: 'pricing tier is seeded, not owner-confirmed' }
  }

  return {
    standDown: true,
    reason:
      `tour matched exactly, ${facts.partySize} guest(s) on ${facts.dateISO} is available ` +
      `under the owner's own rules, and the price is one she confirmed herself`,
  }
}
