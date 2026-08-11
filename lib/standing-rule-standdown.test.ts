import { describe, it, expect } from 'vitest'
import { canStandDown, type StandDownFacts } from './standing-rule-standdown'

/** Everything known, everything clean — the only shape that stands down. */
const CLEAN: StandDownFacts = {
  serviceMatchConfidence: 'high',
  dateISO: '2026-08-26',
  partySize: 8,
  availabilityStatus: 'available',
  tierResolved: true,
  tierOwnerConfirmed: true,
}

describe('canStandDown', () => {
  it('stands down when nothing is left to decide', () => {
    const v = canStandDown(CLEAN)
    expect(v.standDown).toBe(true)
    expect(v.reason).toMatch(/confirmed herself/)
  })

  // Each of these is a single missing fact. All six must fire the rule.
  const blockers: [string, Partial<StandDownFacts>, RegExp][] = [
    ['the tour name is a fuzzy match', { serviceMatchConfidence: 'medium' }, /not high/],
    ['the tour is not in the catalog', { serviceMatchConfidence: 'none' }, /not high/],
    ['confidence is unknown', { serviceMatchConfidence: null }, /absent/],
    ['no date was given', { dateISO: null }, /no date/],
    ['no party size was given', { partySize: null }, /no party size/],
    ['the service has no availability rules', { availabilityStatus: null }, /no availability rules/],
    ['the day is closed to this party size', { availabilityStatus: 'unavailable' }, /unavailable/],
    ['the party is under the departure minimum', { availabilityStatus: 'available_below_minimum' }, /below_minimum/],
    ['pricing is ambiguous', { tierResolved: false }, /unambiguous pricing/],
    ['the price was seeded, not confirmed', { tierOwnerConfirmed: false }, /seeded, not owner-confirmed/],
  ]

  for (const [label, override, reason] of blockers) {
    it(`keeps escalating when ${label}`, () => {
      const v = canStandDown({ ...CLEAN, ...override })
      expect(v.standDown).toBe(false)
      expect(v.reason).toMatch(reason)
    })
  }
})

// ── The six real firings ──────────────────────────────────────────────────
//
// Every escalation the Full Bimini rule has ever produced, replayed. Bimini's
// two availability rules: Sundays only for groups of 6+, and a 3-guest
// departure minimum.
describe('the six real Full Bimini escalations', () => {
  it('Juli King — 2 guests on a Sunday — still goes to Karenda', () => {
    // Sunday, and 2 is under the Sunday minimum of 6. Hard block.
    const v = canStandDown({ ...CLEAN, dateISO: '2026-06-07', partySize: 2, availabilityStatus: 'unavailable' })
    expect(v.standDown).toBe(false)
  })

  it('Delysia Weeks — solo — still goes to Karenda', () => {
    // Under the 3-guest departure minimum: quotable, but with a caveat that
    // is exactly the kind of thing the owner reserved for herself.
    const v = canStandDown({ ...CLEAN, partySize: 1, availabilityStatus: 'available_below_minimum' })
    expect(v.standDown).toBe(false)
  })

  // Kenneth clears the day and the party-size gates: a Wednesday, 8 guests,
  // well over the 3-guest departure minimum. He is blocked on pricing alone.
  it('Kenneth Cal — 8 guests, a Wednesday — clears availability', () => {
    const v = canStandDown({ ...CLEAN, dateISO: '2026-08-26', partySize: 8, availabilityStatus: 'available' })
    expect(v.standDown).toBe(true)
  })

  // ...but in production he does NOT stand down, and this is why.
  //
  // Full Bimini has a shared tier covering 1-50 AND a private tier covering
  // every size. resolveTier holds with `multiple_tiers_matched` at every party
  // size when no variant is supplied, and the website intake form has no
  // shared/private field — verified against the live tiers, 2026-08-11:
  //
  //   party 1, no variant  -> HOLD (multiple_tiers_matched)
  //   party 8, no variant  -> HOLD (multiple_tiers_matched)
  //   party 8, variant=private -> RESOLVED Private Group (7+)
  //
  // So the narrowing is real but inert for this particular rule. The thing
  // actually keeping Karenda in the loop is not the standing rule — it is that
  // "Full Bimini for 8 on Aug 26" genuinely does not say whether the guest
  // wants $199/person shared or $225/person private. That is a question to
  // ask, not a fact to look up.
  it('Kenneth Cal in production — pricing is ambiguous, so it escalates', () => {
    const v = canStandDown({
      ...CLEAN,
      dateISO: '2026-08-26',
      partySize: 8,
      availabilityStatus: 'available',
      tierResolved: false, // multiple_tiers_matched: shared vs private
    })
    expect(v.standDown).toBe(false)
    expect(v.reason).toMatch(/unambiguous pricing/)
  })

  it('an enquiry with no date on it still goes to Karenda', () => {
    // Several of the six were "what does it cost?" with no date at all.
    expect(canStandDown({ ...CLEAN, dateISO: null }).standDown).toBe(false)
  })
})

// The golf cart tours are all seeded pricing with no availability rules, and
// their labels contradict what Karenda quoted on 2026-08-11. Nothing about
// them may ever stand a rule down until she confirms real tiers.
describe('services with seeded pricing', () => {
  it('never stands down on a seeded price', () => {
    const v = canStandDown({ ...CLEAN, tierOwnerConfirmed: false })
    expect(v.standDown).toBe(false)
    expect(v.reason).toMatch(/seeded/)
  })

  it('never stands down when the service has no availability rules', () => {
    const v = canStandDown({ ...CLEAN, availabilityStatus: null })
    expect(v.standDown).toBe(false)
  })
})
