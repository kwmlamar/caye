import { describe, it, expect } from 'vitest'
import {
  shouldSendReviewRequest,
  shouldSendGhostedLeadNudge,
  shouldAutoCompleteBooking,
  decideOutreachLeadAction,
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

describe('decideOutreachLeadAction', () => {
  function makeCandidate(overrides: Partial<Parameters<typeof decideOutreachLeadAction>[0]> = {}) {
    return {
      first_touch_sent_at: '2026-05-30T12:00:00Z', // 2 days ago
      nudge_count: 0,
      last_nudge_at: null,
      opted_out_at: null,
      status: 'sent',
      has_replied: false,
      ...overrides,
    }
  }

  it('nudges at exactly 2 days of silence with no prior nudge', () => {
    expect(decideOutreachLeadAction(makeCandidate(), NOW)).toBe('nudge')
  })

  it('does NOT nudge before 2 days have passed', () => {
    expect(
      decideOutreachLeadAction(
        makeCandidate({ first_touch_sent_at: '2026-05-31T12:00:01Z' }), // just under 2 days
        NOW
      )
    ).toBe('none')
  })

  it('does NOT nudge when the lead has replied', () => {
    expect(decideOutreachLeadAction(makeCandidate({ has_replied: true }), NOW)).toBe('none')
  })

  it('does NOT nudge when the lead opted out', () => {
    expect(
      decideOutreachLeadAction(
        makeCandidate({ opted_out_at: '2026-05-31T00:00:00Z' }),
        NOW
      )
    ).toBe('none')
  })

  it('does NOT nudge when status is not "sent" (e.g. replied/converted/cold)', () => {
    expect(decideOutreachLeadAction(makeCandidate({ status: 'cold' }), NOW)).toBe('none')
  })

  it('does NOT nudge again once one nudge already went out (one follow-up max)', () => {
    expect(
      decideOutreachLeadAction(
        makeCandidate({ nudge_count: 1, last_nudge_at: '2026-05-31T12:00:00Z' }),
        NOW
      )
    ).toBe('none')
  })

  it('marks cold once the one allowed nudge is 14+ days old with still no reply', () => {
    expect(
      decideOutreachLeadAction(
        makeCandidate({ nudge_count: 1, last_nudge_at: '2026-05-18T12:00:00Z' }), // 14 days ago
        NOW
      )
    ).toBe('mark_cold')
  })

  it('does NOT mark cold before 14 days since the nudge', () => {
    expect(
      decideOutreachLeadAction(
        makeCandidate({ nudge_count: 1, last_nudge_at: '2026-05-20T12:00:00Z' }), // 12 days ago
        NOW
      )
    ).toBe('none')
  })

  it('anchors the cold-off window on first_touch_sent_at if last_nudge_at is somehow missing', () => {
    expect(
      decideOutreachLeadAction(
        makeCandidate({
          first_touch_sent_at: '2026-05-18T12:00:00Z', // 14 days ago
          nudge_count: 1,
          last_nudge_at: null,
        }),
        NOW
      )
    ).toBe('mark_cold')
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
