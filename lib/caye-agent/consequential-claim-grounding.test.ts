import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import {
  detectConsequentialPolarityConflict,
  extractBookingStatusClaims,
  validateBookingStatusClaimsAgainstEvidence,
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
