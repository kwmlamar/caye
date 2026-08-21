import { describe, it, expect } from 'vitest'
import {
  businessLocalDate,
  businessTodayLabel,
  classifyBookingDate,
  describeBookingTemporal,
  bookingStatusConflict,
  zonedInstantMs,
} from './booking-time'

// Bimini/Karenda's real workspace timezone. Nassau observes DST (EDT,
// UTC-4) in August.
const TZ = 'America/Nassau'

describe('CAY-91 regression: Aug 18/Aug 19 Sonja incident', () => {
  it('Aug 18 local now + Aug 19 booking classifies as tomorrow, never past', () => {
    // 2026-08-18T18:00:00Z = 2026-08-18 14:00 Nassau (EDT, UTC-4) — solidly
    // inside Aug 18 local, nowhere near the UTC date boundary.
    const now = new Date('2026-08-18T18:00:00Z')
    const result = describeBookingTemporal({ bookingDate: '2026-08-19', timezone: TZ, now })
    expect(result.businessToday).toBe('2026-08-18')
    expect(result.relative).toBe('tomorrow')
    expect(result.relative).not.toBe('past')
  })

  it('classifyBookingDate agrees directly against the business-local today string', () => {
    expect(classifyBookingDate('2026-08-19', '2026-08-18')).toBe('tomorrow')
    expect(classifyBookingDate('2026-08-18', '2026-08-18')).toBe('today')
    expect(classifyBookingDate('2026-08-17', '2026-08-18')).toBe('past')
    expect(classifyBookingDate('2026-08-25', '2026-08-18')).toBe('upcoming')
  })
})

describe('timezone-boundary regression', () => {
  it('the same UTC instant resolves to different business-local dates in different timezones', () => {
    // 2026-08-19T02:00:00Z: still Aug 18 evening in Nassau (UTC-4), but
    // already Aug 19 afternoon in a timezone ahead of UTC.
    const instant = new Date('2026-08-19T02:00:00Z')
    expect(businessLocalDate('America/Nassau', instant)).toBe('2026-08-18')
    expect(businessLocalDate('Pacific/Auckland', instant)).toBe('2026-08-19')
  })

  it('zonedInstantMs resolves a local date+time+timezone tuple to the correct UTC instant', () => {
    // 09:00 Nassau (EDT, UTC-4) on 2026-06-10 = 13:00 UTC.
    expect(zonedInstantMs('2026-06-10', '09:00', 'America/Nassau')).toBe(
      Date.UTC(2026, 5, 10, 13, 0)
    )
  })
})

describe('booking status is independent of temporal classification', () => {
  it('a future booking stays "cancelled" because status says so, not because of date logic', () => {
    const now = new Date('2026-08-18T18:00:00Z')
    // classifyBookingDate/describeBookingTemporal never take status as
    // input at all — a cancelled future booking classifies exactly like
    // any other future booking; the caller's own status field carries the
    // cancellation, this module never infers it.
    const temporal = describeBookingTemporal({ bookingDate: '2026-08-25', timezone: TZ, now })
    expect(temporal.relative).toBe('upcoming')
    // Cancellation is never a conflict, at any relative status — it's an
    // explicit decision, not something date-derived that can disagree
    // with a date.
    expect(bookingStatusConflict('cancelled', temporal.relative)).toBe(false)
    expect(bookingStatusConflict('cancelled', 'past')).toBe(false)
  })
})

describe('conflicting status/date records surface uncertainty, never invent a conclusion', () => {
  it('flags a conflict when status says completed but the date has not happened yet', () => {
    expect(bookingStatusConflict('completed', 'today')).toBe(true)
    expect(bookingStatusConflict('completed', 'tomorrow')).toBe(true)
    expect(bookingStatusConflict('completed', 'upcoming')).toBe(true)
  })

  it('does not flag a conflict when a completed booking is actually in the past', () => {
    expect(bookingStatusConflict('completed', 'past')).toBe(false)
  })

  it('does not flag ordinary confirmed/pending bookings at any relative status', () => {
    expect(bookingStatusConflict('confirmed', 'upcoming')).toBe(false)
    expect(bookingStatusConflict('pending', 'today')).toBe(false)
  })
})

describe('businessTodayLabel', () => {
  it('renders the date in the workspace timezone, not UTC, with a weekday that matches', () => {
    const now = new Date('2026-08-19T02:00:00Z') // Aug 18 evening in Nassau
    const label = businessTodayLabel(TZ, now)
    expect(label).toContain('2026-08-18')
    expect(label).toContain('Tuesday')
    expect(label).not.toContain('2026-08-19')
  })
})
