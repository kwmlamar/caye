import { describe, it, expect } from 'vitest'
import {
  shouldSendReviewRequest,
  shouldSendGhostedLeadNudge,
  shouldAutoCompleteBooking,
} from './nudge-eligibility'

const NOW = new Date('2026-06-01T12:00:00Z')

describe('shouldSendReviewRequest', () => {
  it('fires for a completed booking 2 days ago with no prior review request', () => {
    expect(
      shouldSendReviewRequest(
        { booking_date: '2026-05-30', status: 'completed', review_requested_at: null },
        NOW
      )
    ).toBe(true)
  })

  it('does NOT fire if a review was already requested', () => {
    expect(
      shouldSendReviewRequest(
        {
          booking_date: '2026-05-30',
          status: 'completed',
          review_requested_at: '2026-05-31T12:00:00Z',
        },
        NOW
      )
    ).toBe(false)
  })

  it('does NOT fire for a booking that is not yet completed', () => {
    expect(
      shouldSendReviewRequest(
        { booking_date: '2026-05-30', status: 'confirmed', review_requested_at: null },
        NOW
      )
    ).toBe(false)
  })

  it('does NOT fire for a booking that completed less than 24h ago', () => {
    // Booking today, completed today (status set early by auto-complete or owner)
    expect(
      shouldSendReviewRequest(
        { booking_date: '2026-06-01', status: 'completed', review_requested_at: null },
        NOW
      )
    ).toBe(false)
  })

  it('does NOT fire for cancelled bookings', () => {
    expect(
      shouldSendReviewRequest(
        { booking_date: '2026-05-30', status: 'cancelled', review_requested_at: null },
        NOW
      )
    ).toBe(false)
  })
})

describe('shouldSendGhostedLeadNudge', () => {
  function makeCandidate(overrides: Partial<Parameters<typeof shouldSendGhostedLeadNudge>[0]> = {}) {
    return {
      last_message_at: '2026-05-28T12:00:00Z', // 4 days ago
      last_business_sender_kind: 'caye' as const,
      last_sender_type: 'business' as const,
      nudge_sent_at: null,
      booking_count: 0,
      human_agent_enabled: false,
      ...overrides,
    }
  }

  it('fires when Caye replied 4 days ago with no customer response and no booking', () => {
    expect(shouldSendGhostedLeadNudge(makeCandidate(), NOW)).toBe(true)
  })

  it('does NOT fire when a nudge was already sent on this conversation', () => {
    expect(
      shouldSendGhostedLeadNudge(
        makeCandidate({ nudge_sent_at: '2026-05-31T12:00:00Z' }),
        NOW
      )
    ).toBe(false)
  })

  it('does NOT fire when the customer responded last', () => {
    expect(
      shouldSendGhostedLeadNudge(
        makeCandidate({ last_sender_type: 'customer' }),
        NOW
      )
    ).toBe(false)
  })

  it('does NOT fire when the human owner replied last (not Caye)', () => {
    // Owner replied → conversation isn't really "ghosted by Caye"
    expect(
      shouldSendGhostedLeadNudge(
        makeCandidate({ last_business_sender_kind: 'human' }),
        NOW
      )
    ).toBe(false)
  })

  it('does NOT fire when a booking was created from this conversation', () => {
    expect(
      shouldSendGhostedLeadNudge(
        makeCandidate({ booking_count: 1 }),
        NOW
      )
    ).toBe(false)
  })

  it('does NOT fire when the conversation is held for owner', () => {
    expect(
      shouldSendGhostedLeadNudge(
        makeCandidate({ human_agent_enabled: true }),
        NOW
      )
    ).toBe(false)
  })

  it('does NOT fire when less than 3 days of silence', () => {
    expect(
      shouldSendGhostedLeadNudge(
        makeCandidate({ last_message_at: '2026-05-30T12:00:00Z' }), // 2 days ago
        NOW
      )
    ).toBe(false)
  })

  it('fires at exactly 3 days of silence (boundary)', () => {
    expect(
      shouldSendGhostedLeadNudge(
        makeCandidate({ last_message_at: '2026-05-29T12:00:00Z' }), // exactly 3 days ago
        NOW
      )
    ).toBe(true)
  })
})

describe('shouldAutoCompleteBooking', () => {
  it('flips a confirmed booking that ended 8h ago', () => {
    // Booking yesterday at 09:00, duration 120 min → ended 11:00 yesterday
    // = 25h ago at NOW. Past the 6h buffer.
    expect(
      shouldAutoCompleteBooking(
        {
          status: 'confirmed',
          booking_date: '2026-05-31',
          booking_time: '09:00',
          duration_minutes: 120,
        },
        NOW
      )
    ).toBe(true)
  })

  it('does NOT flip a booking still within the 6h buffer', () => {
    // Booking today 05:00 UTC, duration 120 min → ended 07:00 UTC.
    // NOW (12:00 UTC) is only 5h past the end — inside the 6h buffer.
    expect(
      shouldAutoCompleteBooking(
        {
          status: 'confirmed',
          booking_date: '2026-06-01',
          booking_time: '05:00',
          duration_minutes: 120,
        },
        NOW
      )
    ).toBe(false)
  })

  it('does NOT flip future bookings', () => {
    expect(
      shouldAutoCompleteBooking(
        {
          status: 'confirmed',
          booking_date: '2026-06-05',
          booking_time: '09:00',
          duration_minutes: 120,
        },
        NOW
      )
    ).toBe(false)
  })

  it('does NOT flip cancelled bookings', () => {
    expect(
      shouldAutoCompleteBooking(
        {
          status: 'cancelled',
          booking_date: '2026-05-30',
          booking_time: '09:00',
          duration_minutes: 120,
        },
        NOW
      )
    ).toBe(false)
  })

  it('uses the 120-min default when duration is missing', () => {
    // Booking yesterday 06:00 with null duration → assumed end 08:00 yesterday
    // = 28h ago. Well past the 6h buffer.
    expect(
      shouldAutoCompleteBooking(
        {
          status: 'confirmed',
          booking_date: '2026-05-31',
          booking_time: '06:00',
          duration_minutes: null,
        },
        NOW
      )
    ).toBe(true)
  })

  it('also flips pending bookings (rare but possible)', () => {
    expect(
      shouldAutoCompleteBooking(
        {
          status: 'pending',
          booking_date: '2026-05-31',
          booking_time: '09:00',
          duration_minutes: 120,
        },
        NOW
      )
    ).toBe(true)
  })
})
