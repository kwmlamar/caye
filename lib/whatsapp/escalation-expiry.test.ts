import { describe, it, expect } from 'vitest'
import { shouldExpireOnTargetDate } from './escalation-expiry'

describe('shouldExpireOnTargetDate', () => {
  const todayISO = '2026-08-09'

  it('does not expire a row with no target_date', () => {
    expect(
      shouldExpireOnTargetDate({ targetDate: null, todayISO, latestBookingDate: null })
    ).toBe(false)
  })

  it('does not expire while the target_date is still ahead', () => {
    expect(
      shouldExpireOnTargetDate({ targetDate: '2026-08-20', todayISO, latestBookingDate: null })
    ).toBe(false)
  })

  it('does not expire on the target_date itself', () => {
    expect(
      shouldExpireOnTargetDate({ targetDate: todayISO, todayISO, latestBookingDate: null })
    ).toBe(false)
  })

  it('expires a passed target_date when nothing else is on the books', () => {
    expect(
      shouldExpireOnTargetDate({ targetDate: '2026-08-01', todayISO, latestBookingDate: null })
    ).toBe(true)
  })

  // The Emily Sherman regression (2026-08-09): the golf-cart question was
  // about Aug 9, but her private tour on Aug 20 was still live and still
  // needed a start time. Expiring on target_date alone dropped her from the
  // held queue and reported the queue as empty.
  it('does NOT expire when a later booking is still ahead', () => {
    expect(
      shouldExpireOnTargetDate({
        targetDate: '2026-08-09',
        todayISO: '2026-08-10',
        latestBookingDate: '2026-08-20',
      })
    ).toBe(false)
  })

  it('does not expire when the booking is today', () => {
    expect(
      shouldExpireOnTargetDate({
        targetDate: '2026-08-01',
        todayISO,
        latestBookingDate: todayISO,
      })
    ).toBe(false)
  })

  it('expires when the booking is also in the past', () => {
    expect(
      shouldExpireOnTargetDate({
        targetDate: '2026-08-01',
        todayISO,
        latestBookingDate: '2026-07-30',
      })
    ).toBe(true)
  })

  // latestBookingDateFor returns a far-future sentinel on a read error, so a
  // failed lookup must read as "something is still ahead" and hold the row.
  it('does not expire when the booking lookup failed (sentinel)', () => {
    expect(
      shouldExpireOnTargetDate({
        targetDate: '2026-08-01',
        todayISO,
        latestBookingDate: '9999-12-31',
      })
    ).toBe(false)
  })
})
