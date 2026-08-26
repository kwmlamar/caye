import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import {
  detectConsequentialPolarityConflict,
  extractBookingStatusClaims,
  extractTourTimeClaims,
  validateBookingStatusClaimsAgainstEvidence,
  validateBookingTimeClaimsAgainstEvidence,
} from './consequential-claim-grounding'

describe('CAY-97 consequential claim polarity', () => {
  it('blocks no-refunds grounding from authorizing an affirmative refund', () => {
    expect(
      detectConsequentialPolarityConflict(
        'We will refund your payment in full.',
        'We do not offer refunds.'
      )
    ).toMatch(/contradicts/)
  })

  it('blocks a negative snorkeling-coordination fact from authorizing the opposite partner claim', () => {
    expect(
      detectConsequentialPolarityConflict(
        'We can arrange snorkeling through our trusted partner.',
        'We do not coordinate snorkeling or arrange it through partners.'
      )
    ).toMatch(/contradicts/)
  })

  it('does not invent a conflict when grounding is affirmatively compatible', () => {
    expect(
      detectConsequentialPolarityConflict(
        'We can arrange snorkeling through our trusted partner.',
        'We arrange snorkeling through our trusted partner when requested.'
      )
    ).toBeNull()
  })
})

describe('CAY-97 booking status assertions', () => {
  it('extracts consequential booking status claims only', () => {
    expect(extractBookingStatusClaims('Your booking is confirmed.')).toEqual(['confirmed'])
    expect(extractBookingStatusClaims('Your reservation has been cancelled.')).toEqual(['cancelled'])
  })

  it('blocks confirmed claim when no booking row exists', () => {
    expect(
      validateBookingStatusClaimsAgainstEvidence('Your booking is confirmed.', { statuses: [] })
    ).toMatch(/no authoritative booking row/)
  })

  it('blocks confirmed claim when authoritative state is pending', () => {
    expect(
      validateBookingStatusClaimsAgainstEvidence('Your booking is confirmed.', {
        statuses: ['pending'],
      })
    ).toMatch(/pending/)
  })

  it('allows cancelled claim when authoritative state is cancelled', () => {
    expect(
      validateBookingStatusClaimsAgainstEvidence('Your booking is cancelled.', {
        statuses: ['cancelled'],
      })
    ).toBeNull()
  })

  it('blocks when multiple authoritative booking states conflict', () => {
    expect(
      validateBookingStatusClaimsAgainstEvidence('Your booking is confirmed.', {
        statuses: ['confirmed', 'pending'],
      })
    ).toMatch(/ambiguous\/conflicting/)
  })

  it('allows a scoped explicit owner instruction for this thread', () => {
    expect(
      validateBookingStatusClaimsAgainstEvidence('Your booking is confirmed.', {
        statuses: ['pending'],
        ownerInstructionText: 'Your booking is confirmed.',
      })
    ).toBeNull()
  })
})

describe('2026-08-26 Sonja Pettus incident — booking TIME assertions', () => {
  it('extracts the actual incident text\'s claimed tour time, excluding the "rather than" old time', () => {
    expect(
      extractTourTimeClaims(
        'We wanted to reach out to let you know that we would like to adjust your tour start time to 10:00 a.m. rather than 9:00 a.m.'
      )
    ).toEqual(['10:00'])
  })

  it('extracts the claimed time from "Tour Start Time: X (please note the updated time from Y)" phrasing, excluding Y', () => {
    expect(
      extractTourTimeClaims('Tour Start Time: 10:00 a.m. (please note the updated time from 9:00 a.m.)')
    ).toEqual(['10:00'])
  })

  it('extracts a bare 24h time next to "tour" (the payment-confirmation phrasing that actually shipped)', () => {
    expect(
      extractTourTimeClaims("we've received your payment for your tour on Wednesday, August 26 at 09:00. You're all set!")
    ).toEqual(['09:00'])
  })

  it('ignores non-tour times entirely (a pickup/ferry time is not a tour-time claim)', () => {
    expect(extractTourTimeClaims('Ferry departs at 9:00 a.m. sharp.')).toEqual([])
  })

  it('THE INCIDENT: blocks a "10:00 a.m." tour-time claim while the authoritative booking record still says 09:00:00', () => {
    const result = validateBookingTimeClaimsAgainstEvidence(
      'We wanted to reach out to let you know that we would like to adjust your tour start time to 10:00 a.m. rather than 9:00 a.m.',
      '09:00:00'
    )
    expect(result).toMatch(/claims the tour time is "10:00"/)
    expect(result).toMatch(/authoritative booking record still shows "09:00"/)
  })

  it('THE FIX: allows the same claim once the authoritative booking record has actually been rescheduled to 10:00:00', () => {
    expect(
      validateBookingTimeClaimsAgainstEvidence(
        'Tour Start Time: 10:00 a.m. (please note the updated time from 9:00 a.m.)',
        '10:00:00'
      )
    ).toBeNull()
  })

  it('does not block when the draft makes no tour-time claim at all', () => {
    expect(validateBookingTimeClaimsAgainstEvidence('Looking forward to seeing you!', '09:00:00')).toBeNull()
  })

  it('does not block when there is no linked booking time to check against', () => {
    expect(
      validateBookingTimeClaimsAgainstEvidence('Your tour is at 10:00 a.m.', null)
    ).toBeNull()
  })

  it('has NO owner-instruction override — unlike booking status, an operator statement never grounds a time claim by itself', () => {
    // (validateBookingTimeClaimsAgainstEvidence takes no ownerInstructionText
    // parameter at all — this test documents that omission is deliberate.)
    expect(validateBookingTimeClaimsAgainstEvidence.length).toBe(2)
  })
})
