import { describe, it, expect } from 'vitest'
import { evaluateOperatingDate, type OperatingRules } from './operating-rules'

/**
 * Fixture mirrors what we seed for Bimini Island Tours:
 *   - Sundays (0) routed to the owner (driver Max at church until 11am)
 *   - Holiday closure Dec 23 → Jan 3 (wraps the year boundary)
 *   - Summer closure Aug 1 → Aug 9
 */
const BIMINI: OperatingRules = {
  owner_only_weekdays: [0],
  blackout_dates: [
    { start: '12-23', end: '01-03', label: 'Holiday closure', recurring_annually: true },
    { start: '08-01', end: '08-09', label: 'Summer closure', recurring_annually: true },
  ],
}

describe('evaluateOperatingDate', () => {
  it('returns open on a normal weekday', () => {
    // 2026-06-25 is a Thursday, no closure.
    expect(evaluateOperatingDate('2026-06-25', BIMINI)).toEqual({ status: 'open' })
  })

  it('routes Sundays to the owner', () => {
    // 2026-06-28 is a Sunday.
    expect(evaluateOperatingDate('2026-06-28', BIMINI)).toEqual({
      status: 'owner_only',
      weekday: 0,
    })
  })

  it('closes inside the summer range (inclusive bounds)', () => {
    expect(evaluateOperatingDate('2026-08-01', BIMINI)).toMatchObject({ status: 'closed' })
    expect(evaluateOperatingDate('2026-08-05', BIMINI)).toMatchObject({ status: 'closed' })
    expect(evaluateOperatingDate('2026-08-09', BIMINI)).toMatchObject({ status: 'closed' })
  })

  it('reopens the day after the summer range', () => {
    expect(evaluateOperatingDate('2026-08-10', BIMINI)).toEqual({ status: 'open' })
  })

  it('closes across the year-boundary wrap (December side)', () => {
    expect(evaluateOperatingDate('2026-12-23', BIMINI)).toMatchObject({ status: 'closed' })
    expect(evaluateOperatingDate('2026-12-31', BIMINI)).toMatchObject({ status: 'closed' })
  })

  it('closes across the year-boundary wrap (January side)', () => {
    expect(evaluateOperatingDate('2027-01-01', BIMINI)).toMatchObject({ status: 'closed' })
    expect(evaluateOperatingDate('2027-01-03', BIMINI)).toMatchObject({ status: 'closed' })
  })

  it('reopens January 4th', () => {
    // 2027-01-04 is a Monday, so not owner_only either.
    expect(evaluateOperatingDate('2027-01-04', BIMINI)).toEqual({ status: 'open' })
  })

  it('closure wins over owner_only when a closed date is also a Sunday', () => {
    // 2026-08-02 is a Sunday AND inside the summer closure → closed wins.
    expect(evaluateOperatingDate('2026-08-02', BIMINI)).toMatchObject({ status: 'closed' })
  })

  it('handles one-time (non-recurring) ranges by full ISO date', () => {
    const oneTime: OperatingRules = {
      owner_only_weekdays: [],
      blackout_dates: [
        { start: '2026-07-04', end: '2026-07-06', label: 'Private event', recurring_annually: false },
      ],
    }
    expect(evaluateOperatingDate('2026-07-05', oneTime)).toMatchObject({ status: 'closed' })
    // Same month-day a year later must NOT match a one-time range.
    expect(evaluateOperatingDate('2027-07-05', oneTime)).toEqual({ status: 'open' })
  })

  it('is open when no rules are configured', () => {
    expect(
      evaluateOperatingDate('2026-06-28', { owner_only_weekdays: [], blackout_dates: [] })
    ).toEqual({ status: 'open' })
  })
})
