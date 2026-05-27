import { describe, it, expect } from 'vitest'
import {
  summarizeBookingHistory,
  formatCustomerHistoryBlock,
  type BookingHistoryRow,
} from './customer-history'

describe('summarizeBookingHistory', () => {
  it('returns the not-returning zero state for first-time customers', () => {
    const summary = summarizeBookingHistory([])
    expect(summary.is_returning).toBe(false)
    expect(summary.past_booking_count).toBe(0)
    expect(summary.last_booking).toBeNull()
    expect(summary.typical_party_size).toBeNull()
  })

  it('marks any prior booking as returning, even one', () => {
    const summary = summarizeBookingHistory([
      { booking_date: '2026-03-12', service_name: 'Full Bimini', status: 'completed', number_of_people: 4 },
    ])
    expect(summary.is_returning).toBe(true)
    expect(summary.past_booking_count).toBe(1)
    expect(summary.completed_count).toBe(1)
    expect(summary.cancelled_count).toBe(0)
  })

  it('counts completed vs cancelled correctly', () => {
    const rows: BookingHistoryRow[] = [
      { booking_date: '2026-01-10', service_name: 'Full Bimini', status: 'completed', number_of_people: 2 },
      { booking_date: '2026-02-15', service_name: 'Eat Like a Local', status: 'completed', number_of_people: 4 },
      { booking_date: '2026-04-22', service_name: 'Full Bimini', status: 'cancelled', number_of_people: 6 },
      { booking_date: '2026-05-01', service_name: 'Full Bimini', status: 'pending', number_of_people: 3 },
    ]
    const summary = summarizeBookingHistory(rows)
    expect(summary.past_booking_count).toBe(4)
    expect(summary.completed_count).toBe(2)
    expect(summary.cancelled_count).toBe(1)
  })

  it('picks the most recent booking as last_booking, regardless of input order', () => {
    const rows: BookingHistoryRow[] = [
      { booking_date: '2026-03-12', service_name: 'Full Bimini', status: 'completed', number_of_people: 4 },
      { booking_date: '2026-05-30', service_name: 'Eat Like a Local', status: 'completed', number_of_people: 2 },
      { booking_date: '2026-01-05', service_name: 'Full Bimini', status: 'cancelled', number_of_people: 6 },
    ]
    const summary = summarizeBookingHistory(rows)
    expect(summary.last_booking?.date).toBe('2026-05-30')
    expect(summary.last_booking?.service_name).toBe('Eat Like a Local')
  })

  it('rounds typical party size from average across all bookings', () => {
    const rows: BookingHistoryRow[] = [
      { booking_date: '2026-01-10', service_name: null, status: 'completed', number_of_people: 2 },
      { booking_date: '2026-02-15', service_name: null, status: 'completed', number_of_people: 5 },
    ]
    // (2 + 5) / 2 = 3.5 → rounds to 4
    expect(summarizeBookingHistory(rows).typical_party_size).toBe(4)
  })

  it('ignores zero-party-size rows when computing the average', () => {
    const rows: BookingHistoryRow[] = [
      { booking_date: '2026-01-10', service_name: null, status: 'completed', number_of_people: 4 },
      { booking_date: '2026-02-15', service_name: null, status: 'completed', number_of_people: 0 },
    ]
    // Only the 4-guest booking counts → avg 4
    expect(summarizeBookingHistory(rows).typical_party_size).toBe(4)
  })
})

describe('formatCustomerHistoryBlock', () => {
  it('returns empty string for first-time customers', () => {
    const block = formatCustomerHistoryBlock(summarizeBookingHistory([]))
    expect(block).toBe('')
  })

  it('opens with the CUSTOMER HISTORY header and tells Caye to acknowledge naturally', () => {
    const block = formatCustomerHistoryBlock(
      summarizeBookingHistory([
        { booking_date: '2026-03-12', service_name: 'Full Bimini', status: 'completed', number_of_people: 4 },
      ])
    )
    expect(block).toMatch(/^CUSTOMER HISTORY/)
    expect(block.toLowerCase()).toContain('returning customer')
    expect(block.toLowerCase()).toContain('acknowledge')
    expect(block.toLowerCase()).toContain("don't re-ask")
  })

  it('includes the past-bookings breakdown', () => {
    const block = formatCustomerHistoryBlock(
      summarizeBookingHistory([
        { booking_date: '2026-01-10', service_name: 'Full Bimini', status: 'completed', number_of_people: 4 },
        { booking_date: '2026-02-15', service_name: 'Full Bimini', status: 'cancelled', number_of_people: 4 },
      ])
    )
    expect(block).toContain('1 completed')
    expect(block).toContain('1 cancelled')
    expect(block).toContain('(2 total)')
  })

  it('includes the last booking date + service', () => {
    const block = formatCustomerHistoryBlock(
      summarizeBookingHistory([
        { booking_date: '2026-03-12', service_name: 'Eat Like a Local', status: 'completed', number_of_people: 4 },
      ])
    )
    expect(block).toContain('2026-03-12')
    expect(block).toContain('Eat Like a Local')
  })

  it('tells Caye to be tactful about cancellations', () => {
    // Even one cancellation in history surfaces the tact instruction so
    // Caye doesn't accidentally reference it unprompted.
    const block = formatCustomerHistoryBlock(
      summarizeBookingHistory([
        { booking_date: '2026-03-12', service_name: 'Full Bimini', status: 'cancelled', number_of_people: 4 },
      ])
    )
    expect(block.toLowerCase()).toContain('cancellation')
    expect(block.toLowerCase()).toContain('tactful')
  })

  it('omits typical party size when the average is unavailable', () => {
    const summary = summarizeBookingHistory([
      { booking_date: '2026-03-12', service_name: 'Full Bimini', status: 'completed', number_of_people: 0 },
    ])
    const block = formatCustomerHistoryBlock(summary)
    expect(block).not.toContain('Typical party size')
  })
})
