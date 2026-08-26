import { describe, it, expect } from 'vitest'
import {
  evaluateServiceAvailability,
  evaluateServiceAvailabilityWithOverrides,
  evaluateDateOverride,
  buildAvailabilityBlock,
  weekdayOf,
  type ServiceAvailabilityRule,
  type ServiceDateOverride,
} from './service-availability'
import {
  matchServiceByName,
  extractCustomerTourName,
  extractCustomerRequestedDate,
  extractCustomerPartySize,
} from './match-service'

const rule = (over: Partial<ServiceAvailabilityRule> = {}): ServiceAvailabilityRule => ({
  id: 'r1',
  weekday: null,
  effect: 'unavailable',
  min_party: null,
  note: null,
  ...over,
})

// Bimini's two real rules, as taught on 2026-08-09.
const SUNDAY_FULL_BIMINI = rule({
  id: 'sunday',
  weekday: 0,
  effect: 'unavailable',
  min_party: 6,
  note: 'Full Bimini Experience only runs Sundays for groups of 6 or more.',
})
const FULL_BIMINI_DEPARTURE = rule({
  id: 'departure',
  weekday: null,
  effect: 'departure_minimum',
  min_party: 3,
  note: 'Needs 3-4 guests to run.',
})

const SUNDAY = '2026-08-16' // Juli King's requested date
const MONDAY = '2026-12-14' // Delysia Weeks' requested date

describe('weekdayOf', () => {
  it('reads dates as UTC so a timezone cannot shift the day', () => {
    expect(weekdayOf(SUNDAY)).toBe(0)
    expect(weekdayOf(MONDAY)).toBe(1)
  })
})

describe('evaluateServiceAvailability', () => {
  it('is available when there are no rules', () => {
    expect(
      evaluateServiceAvailability({ rules: [], dateISO: SUNDAY, partySize: 2 }).status
    ).toBe('available')
  })

  it('is available when the enquiry states no date', () => {
    expect(
      evaluateServiceAvailability({
        rules: [SUNDAY_FULL_BIMINI],
        dateISO: null,
        partySize: 2,
      }).status
    ).toBe('available')
  })

  // Juli King: Full Bimini, Sunday Aug 16, 2 guests. Yesterday this was an
  // escalation and Mrs. Max hand-dictated the alternatives.
  it('blocks a small party on the restricted weekday', () => {
    const v = evaluateServiceAvailability({
      rules: [SUNDAY_FULL_BIMINI],
      dateISO: SUNDAY,
      partySize: 2,
    })
    expect(v.status).toBe('unavailable')
    if (v.status === 'unavailable') expect(v.availableFromPartySize).toBe(6)
  })

  it('lets a big enough group through on the same weekday', () => {
    expect(
      evaluateServiceAvailability({
        rules: [SUNDAY_FULL_BIMINI],
        dateISO: SUNDAY,
        partySize: 6,
      }).status
    ).toBe('available')
  })

  it('does not apply a liftable block when the party size is unknown', () => {
    // Refusing here would turn a 7-person booking into a lost one.
    expect(
      evaluateServiceAvailability({
        rules: [SUNDAY_FULL_BIMINI],
        dateISO: SUNDAY,
        partySize: null,
      }).status
    ).toBe('available')
  })

  it('still applies an unliftable block when the party size is unknown', () => {
    const closed = rule({ weekday: 0, effect: 'unavailable', min_party: null })
    expect(
      evaluateServiceAvailability({ rules: [closed], dateISO: SUNDAY, partySize: null }).status
    ).toBe('unavailable')
  })

  it('ignores a weekday rule on other days', () => {
    expect(
      evaluateServiceAvailability({
        rules: [SUNDAY_FULL_BIMINI],
        dateISO: MONDAY,
        partySize: 2,
      }).status
    ).toBe('available')
  })

  // Delysia Weeks: solo, Monday Dec 14. Must NOT be refused — the owner
  // approved quoting her with the caveat.
  it('flags a departure minimum without refusing the booking', () => {
    const v = evaluateServiceAvailability({
      rules: [FULL_BIMINI_DEPARTURE],
      dateISO: MONDAY,
      partySize: 1,
    })
    expect(v.status).toBe('available_below_minimum')
    if (v.status === 'available_below_minimum') expect(v.departureMinimum).toBe(3)
  })

  it('says nothing when the party already meets the departure minimum', () => {
    expect(
      evaluateServiceAvailability({
        rules: [FULL_BIMINI_DEPARTURE],
        dateISO: MONDAY,
        partySize: 3,
      }).status
    ).toBe('available')
  })

  it('prefers a hard block over a departure minimum when both apply', () => {
    const v = evaluateServiceAvailability({
      rules: [FULL_BIMINI_DEPARTURE, SUNDAY_FULL_BIMINI],
      dateISO: SUNDAY,
      partySize: 2,
    })
    expect(v.status).toBe('unavailable')
  })
})

describe('buildAvailabilityBlock', () => {
  const name = 'Full Bimini Experience'

  it('adds nothing when everything is fine', () => {
    expect(
      buildAvailabilityBlock({
        verdict: { status: 'available' },
        serviceName: name,
        dateISO: SUNDAY,
      })
    ).toBe('')
  })

  it('names the day, the lift threshold, and forbids quoting', () => {
    const block = buildAvailabilityBlock({
      verdict: evaluateServiceAvailability({
        rules: [SUNDAY_FULL_BIMINI],
        dateISO: SUNDAY,
        partySize: 2,
      }),
      serviceName: name,
      dateISO: SUNDAY,
    })
    expect(block).toContain('Sunday')
    expect(block).toContain('CANNOT run')
    expect(block).toContain('6 or more')
    expect(block).toMatch(/do not quote a price/i)
  })

  // The failure this whole module exists to prevent.
  it('tells the model to still quote below the departure minimum', () => {
    const block = buildAvailabilityBlock({
      verdict: evaluateServiceAvailability({
        rules: [FULL_BIMINI_DEPARTURE],
        dateISO: MONDAY,
        partySize: 1,
      }),
      serviceName: name,
      dateISO: MONDAY,
    })
    expect(block).toMatch(/NOT a refusal/i)
    expect(block).toContain('3 guests')
    expect(block).toMatch(/never be restated as a flat total/i)
  })
})

// ── service_date_overrides (Operator Learning Router, Bimini fixture #7) ──
//
// "Only private tours are available on September 5" — a one-off date
// restriction, must never leak into a standing weekday rule.
describe('evaluateDateOverride / evaluateServiceAvailabilityWithOverrides', () => {
  const SEPT_5 = '2026-09-05'
  const SEPT_6 = '2026-09-06'

  const override = (over: Partial<ServiceDateOverride> = {}): ServiceDateOverride => ({
    id: 'ov1',
    date_iso: SEPT_5,
    effect: 'variant_only',
    min_party: null,
    restricted_variant: 'private',
    note: null,
    ...over,
  })

  it('returns null when no override matches the date', () => {
    expect(evaluateDateOverride({ overrides: [], dateISO: SEPT_5 })).toBeNull()
    expect(evaluateDateOverride({ overrides: [override()], dateISO: SEPT_6 })).toBeNull()
  })

  it('returns null when dateISO is null', () => {
    expect(evaluateDateOverride({ overrides: [override()], dateISO: null })).toBeNull()
  })

  it('restricts the date to one variant without touching other dates', () => {
    const v = evaluateDateOverride({ overrides: [override()], dateISO: SEPT_5 })
    expect(v?.status).toBe('variant_restricted')
    if (v?.status === 'variant_restricted') expect(v.restrictedToVariant).toBe('private')

    // The day AFTER the override is untouched — this must not generalize
    // into a standing rule.
    expect(evaluateDateOverride({ overrides: [override()], dateISO: SEPT_6 })).toBeNull()
  })

  it('a date override takes precedence over a recurring weekday rule for that date', () => {
    const fridayWeekday = weekdayOf(SEPT_5) // whatever weekday Sept 5 2026 actually is
    const recurringRule: ServiceAvailabilityRule = {
      id: 'weekday-rule',
      weekday: fridayWeekday,
      effect: 'departure_minimum',
      min_party: 4,
      note: 'Needs 4 to run that weekday.',
    }
    const v = evaluateServiceAvailabilityWithOverrides({
      rules: [recurringRule],
      overrides: [override()],
      dateISO: SEPT_5,
      partySize: 2,
    })
    expect(v.status).toBe('variant_restricted')
  })

  it('falls back to the recurring weekday rule when no override applies', () => {
    const recurringRule: ServiceAvailabilityRule = {
      id: 'weekday-rule',
      weekday: weekdayOf(SEPT_6),
      effect: 'unavailable',
      min_party: null,
      note: 'Closed.',
    }
    const v = evaluateServiceAvailabilityWithOverrides({
      rules: [recurringRule],
      overrides: [override()], // only applies to SEPT_5
      dateISO: SEPT_6,
      partySize: 2,
    })
    expect(v.status).toBe('unavailable')
  })

  it('a full unavailable override beats a variant-only override for the same date', () => {
    const v = evaluateDateOverride({
      overrides: [override({ id: 'block', effect: 'unavailable', min_party: null }), override()],
      dateISO: SEPT_5,
    })
    expect(v?.status).toBe('unavailable')
  })
})

describe('buildAvailabilityBlock — variant_restricted', () => {
  it('names the variant and forbids quoting other variants for that date only', () => {
    const block = buildAvailabilityBlock({
      verdict: {
        status: 'variant_restricted',
        restrictedToVariant: 'private',
        reason: 'Shared boat is in maintenance.',
        overrideId: 'ov1',
      },
      serviceName: 'Full Bimini Experience',
      dateISO: '2026-09-05',
    })
    expect(block).toContain('private')
    expect(block).toContain('Full Bimini Experience')
    expect(block).toMatch(/this date only/i)
  })
})

// ── End-to-end against the real inbound that caused the escalation ────────
//
// Juli King's intake form, verbatim from unified_messages. Yesterday this
// became a held escalation and Mrs. Max hand-dictated the alternatives over
// WhatsApp. The point of this module is that the three fields needed to
// answer it are right there in the message.
describe('Juli King, 2026-06-07 (the real one)', () => {
  const JULI_INTAKE = [
    'Name: Juli King',
    'Email: juli.whaley@yahoo.com',
    'Phone: 3305100228',
    'Guests: 2',
    'Age Range: All Adults',
    'Date: Sunday, June 7, 2026',
    'DateISO: 2026-06-07',
    'Tour: Full Bimini Experience',
    'Notes: Hello, wondering about the cost per hour?',
  ].join('\n')

  const CATALOG = [
    { id: 'fb', name: 'Full Bimini Experience' },
    { id: 'nb', name: 'North Bimini Heritage Tour' },
    { id: 'sl', name: 'Bimini Sit-Low Sightseeing' },
  ]

  it('pulls tour, date and party size straight out of the form', () => {
    expect(extractCustomerTourName(JULI_INTAKE)).toBe('Full Bimini Experience')
    expect(extractCustomerRequestedDate(JULI_INTAKE)).toBe('2026-06-07')
    expect(extractCustomerPartySize(JULI_INTAKE)).toBe(2)
  })

  it('matches the catalog with high confidence', () => {
    const m = matchServiceByName(CATALOG, extractCustomerTourName(JULI_INTAKE)!)
    expect(m.confidence).toBe('high')
    expect(m.best?.id).toBe('fb')
  })

  it('lands on unavailable, and the prompt block says why', () => {
    const verdict = evaluateServiceAvailability({
      rules: [SUNDAY_FULL_BIMINI, FULL_BIMINI_DEPARTURE],
      dateISO: extractCustomerRequestedDate(JULI_INTAKE),
      partySize: extractCustomerPartySize(JULI_INTAKE),
    })
    expect(verdict.status).toBe('unavailable')

    const block = buildAvailabilityBlock({
      verdict,
      serviceName: 'Full Bimini Experience',
      dateISO: '2026-06-07',
    })
    expect(block).toContain('CANNOT run on Sunday 2026-06-07')
    expect(block).toContain('6 or more')
    expect(block).toContain('offer the alternatives')
  })
})
