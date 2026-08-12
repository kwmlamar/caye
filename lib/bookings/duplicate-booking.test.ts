import { describe, it, expect } from 'vitest'
import { findDuplicateBooking, type ExistingBooking } from './duplicate-booking'

const booking = (over: Partial<ExistingBooking> = {}): ExistingBooking => ({
  id: 'b1',
  customer_name: 'Karin Roberts',
  customer_email: 'karinroberts63@gmail.com',
  booking_date: '2026-11-06',
  booking_time: '09:00:00',
  number_of_people: 2,
  status: 'pending',
  ...over,
})

// The real pair from Karenda's calendar.
const KARIN_FIRST = booking({ id: 'a0ea0b93' })
const KARIN_SECOND = {
  customer_name: 'Karin Roberts',
  customer_email: 'karinroberts63@gmail.com',
  booking_date: '2026-11-06',
}

describe('Karin Roberts, 2026-11-06 (the real one)', () => {
  it('catches the second booking Caye made two days later', () => {
    const v = findDuplicateBooking({ existing: [KARIN_FIRST], candidate: KARIN_SECOND })
    expect(v.duplicate).toBe(true)
    if (v.duplicate) {
      expect(v.existing.id).toBe('a0ea0b93')
      expect(v.matchedBy).toBe('email')
    }
  })

  it('tells the model not to retry the insert', () => {
    const v = findDuplicateBooking({ existing: [KARIN_FIRST], candidate: KARIN_SECOND })
    expect(v.duplicate).toBe(true)
    if (v.duplicate) {
      expect(v.message).toContain('Karin Roberts')
      expect(v.message).toContain('2026-11-06')
      expect(v.message).toMatch(/did NOT create a second one/i)
      expect(v.message).toMatch(/instead of making\s+a new one/i)
    }
  })
})

describe('findDuplicateBooking', () => {
  it('allows a booking when nothing is on file', () => {
    expect(findDuplicateBooking({ existing: [], candidate: KARIN_SECOND }).duplicate).toBe(false)
  })

  it('allows the same guest on a different date', () => {
    const v = findDuplicateBooking({
      existing: [KARIN_FIRST],
      candidate: { ...KARIN_SECOND, booking_date: '2026-11-07' },
    })
    expect(v.duplicate).toBe(false)
  })

  it('allows a different guest on the same date', () => {
    const v = findDuplicateBooking({
      existing: [KARIN_FIRST],
      candidate: { ...KARIN_SECOND, customer_email: 'someoneelse@gmail.com', customer_name: 'Juli King' },
    })
    expect(v.duplicate).toBe(false)
  })

  // A cancelled booking is history. Rebooking after a cancellation is normal.
  it('ignores cancelled bookings', () => {
    const v = findDuplicateBooking({
      existing: [booking({ status: 'cancelled' })],
      candidate: KARIN_SECOND,
    })
    expect(v.duplicate).toBe(false)
  })

  it('catches duplicates against confirmed bookings too', () => {
    const v = findDuplicateBooking({
      existing: [booking({ status: 'confirmed' })],
      candidate: KARIN_SECOND,
    })
    expect(v.duplicate).toBe(true)
  })

  it('is case- and whitespace-insensitive on email', () => {
    const v = findDuplicateBooking({
      existing: [booking({ customer_email: '  KarinRoberts63@Gmail.com ' })],
      candidate: KARIN_SECOND,
    })
    expect(v.duplicate).toBe(true)
  })

  // Time is not part of the match — a duplicate booked at a different hour is
  // still a duplicate, and Karin's happened to share a time by luck.
  it('catches a duplicate booked at a different time of day', () => {
    const v = findDuplicateBooking({
      existing: [booking({ booking_time: '13:00:00' })],
      candidate: KARIN_SECOND,
    })
    expect(v.duplicate).toBe(true)
  })

  describe('name fallback', () => {
    it('matches on name when neither side has an email', () => {
      const v = findDuplicateBooking({
        existing: [booking({ customer_email: null })],
        candidate: { customer_name: 'karin  roberts', customer_email: null, booking_date: '2026-11-06' },
      })
      expect(v.duplicate).toBe(true)
      if (v.duplicate) expect(v.matchedBy).toBe('name')
    })

    // Same name, different email is a different person. Collapsing them would
    // silently refuse a real second guest their booking.
    it('does not collapse two people who share a name', () => {
      const v = findDuplicateBooking({
        existing: [booking({ customer_email: 'karin.a@gmail.com' })],
        candidate: { ...KARIN_SECOND, customer_email: 'karin.b@gmail.com' },
      })
      expect(v.duplicate).toBe(false)
    })

    // One side knowing the email and the other not is too weak to act on.
    it('does not match on name when only one side has an email', () => {
      const v = findDuplicateBooking({
        existing: [booking({ customer_email: null })],
        candidate: KARIN_SECOND,
      })
      expect(v.duplicate).toBe(false)
    })
  })

  it('returns the first active match when several exist', () => {
    const v = findDuplicateBooking({
      existing: [booking({ id: 'cancelled', status: 'cancelled' }), booking({ id: 'live' })],
      candidate: KARIN_SECOND,
    })
    expect(v.duplicate).toBe(true)
    if (v.duplicate) expect(v.existing.id).toBe('live')
  })

  it('survives null names and emails without matching everything', () => {
    const v = findDuplicateBooking({
      existing: [booking({ customer_name: null, customer_email: null })],
      candidate: { customer_name: 'Karin Roberts', customer_email: null, booking_date: '2026-11-06' },
    })
    expect(v.duplicate).toBe(false)
  })
})
