import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Shared booking lookup for a workspace + date range.
 *
 * Extracted from the get_calendar tool (2026-08-07) so the escalation path
 * can answer "is that date free?" through the same query the tool uses.
 * Before this, an escalation handed the operator a date with no calendar
 * context at all — the operator's first question ("am I even free?") was
 * one Caye already had the data to answer.
 *
 * Cancelled bookings are excluded, same as the tool.
 */

export interface BookingLite {
  customer_name: string
  booking_date: string
  booking_time: string
  number_of_people: number
  status: string
  service: { name: string }[] | null
}

export async function fetchBookingsInRange(
  workspaceId: string,
  startISO: string,
  endISO: string
): Promise<{ ok: true; bookings: BookingLite[] } | { ok: false; error: string }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('bookings')
    .select(
      'customer_name, booking_date, booking_time, number_of_people, status, service:booking_services(name)'
    )
    .eq('user_id', workspaceId)
    .gte('booking_date', startISO)
    .lte('booking_date', endISO)
    .neq('status', 'cancelled')
    .order('booking_date')
    .order('booking_time')

  if (error) return { ok: false, error: error.message }
  return { ok: true, bookings: (data ?? []) as BookingLite[] }
}

export interface DayAvailability {
  dateISO: string
  /** Non-cancelled bookings already on that date. Empty means the day is open. */
  bookings: BookingLite[]
}

/**
 * Single-day availability read. Returns null (rather than throwing) on any
 * failure — every caller treats calendar context as a nice-to-have layered
 * onto an operator message that must go out regardless.
 */
export async function getDayAvailability(
  workspaceId: string,
  dateISO: string
): Promise<DayAvailability | null> {
  const result = await fetchBookingsInRange(workspaceId, dateISO, dateISO)
  if (!result.ok) {
    console.warn('[calendar-availability] lookup failed:', result.error)
    return null
  }
  return { dateISO, bookings: result.bookings }
}
