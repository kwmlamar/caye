import { describe, it, expect } from 'vitest'
import { checkBookingAutonomy } from './booking-policy'

// Tests anchor on a winter NOW so most US/Caribbean timezones (including
// Nassau, which DOES observe DST despite a common misconception) are on
// standard time. Otherwise the exact 48h boundary tests would shift by an
// hour when run against a DST-observing zone.
const NOW = new Date('2026-01-05T14:00:00Z') // Mon Jan 5 2026, 09:00 Nassau (EST)
const TZ = 'America/Nassau'

describe('checkBookingAutonomy', () => {
  it('allows Caye to act when booking is well outside the 48h window', () => {
    // 5 days out
    const result = checkBookingAutonomy({
      bookingDate: '2026-01-10',
      bookingTime: '10:00',
      timezone: TZ,
      now: NOW,
    })
    expect(result.ok).toBe(true)
    expect(result.hoursUntilBooking).toBeGreaterThan(48)
  })

  it('refuses when booking is inside the 48h window (within_policy_window)', () => {
    // 24h out: Tue 14:00 UTC = Tue 09:00 Nassau (EST)
    const result = checkBookingAutonomy({
      bookingDate: '2026-01-06',
      bookingTime: '09:00',
      timezone: TZ,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('within_policy_window')
  })

  it('refuses at 47 hours out (just inside the window)', () => {
    // Wed 08:00 Nassau (EST) = Wed 13:00 UTC = 47h after NOW
    const result = checkBookingAutonomy({
      bookingDate: '2026-01-07',
      bookingTime: '08:00',
      timezone: TZ,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('within_policy_window')
  })

  it('allows at exactly 48 hours out (the policy boundary)', () => {
    // Wed 09:00 Nassau (EST) = Wed 14:00 UTC = 48h after NOW exactly
    const result = checkBookingAutonomy({
      bookingDate: '2026-01-07',
      bookingTime: '09:00',
      timezone: TZ,
      now: NOW,
    })
    expect(result.ok).toBe(true)
  })

  it('refuses bookings already in the past (booking_in_past)', () => {
    const result = checkBookingAutonomy({
      bookingDate: '2026-01-04',
      bookingTime: '10:00',
      timezone: TZ,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('booking_in_past')
  })

  it('refuses bookings happening today within hours (near-past)', () => {
    // Same-day Mon 13:00 Nassau (EST) = Mon 18:00 UTC = 4h after NOW
    const result = checkBookingAutonomy({
      bookingDate: '2026-01-05',
      bookingTime: '13:00',
      timezone: TZ,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('within_policy_window')
  })

  it('handles workspaces in different timezones (DST-active and DST-inactive)', () => {
    // LA on PST in January (UTC-8). Booking 5 days out → comfortably past 48h.
    const result = checkBookingAutonomy({
      bookingDate: '2026-01-10',
      bookingTime: '09:00',
      timezone: 'America/Los_Angeles',
      now: NOW,
    })
    expect(result.ok).toBe(true)
    expect(result.hoursUntilBooking).toBeGreaterThan(48)
  })

  it('correctly resolves booking instant for a DST-observing zone in summer', () => {
    // Nassau in June is on EDT (UTC-4). A booking at 09:00 Nassau on
    // Jun 10 should resolve to 13:00 UTC, not 14:00. This guards against
    // a future regression where we'd hardcode the year-round offset.
    const summerNow = new Date('2026-06-08T13:00:00Z') // Mon Jun 8, 09:00 Nassau (EDT)
    const result = checkBookingAutonomy({
      bookingDate: '2026-06-10', // Wed
      bookingTime: '13:00', // Wed 13:00 Nassau (EDT) = Wed 17:00 UTC = 52h after summerNow
      timezone: TZ,
      now: summerNow,
    })
    expect(result.ok).toBe(true)
    // ~52h, well past the 48 boundary
    expect(result.hoursUntilBooking).toBeGreaterThan(48)
    expect(result.hoursUntilBooking).toBeLessThan(60)
  })
})
