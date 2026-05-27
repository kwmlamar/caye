/**
 * Pure summarisation + prompt formatting for the "is this a returning
 * customer?" signal. Extracted from caye-reply.ts so the summary logic
 * and prompt rendering can be unit tested without Supabase.
 *
 * What goes in: raw booking rows for a contact (any status, any date).
 * What comes out: a compact summary Caye reads BEFORE replying, so she
 * can acknowledge returning customers naturally and avoid asking for
 * info already in their history.
 */

export interface BookingHistoryRow {
  /** YYYY-MM-DD */
  booking_date: string
  service_name: string | null
  status: string
  number_of_people: number
}

export interface CustomerHistorySummary {
  is_returning: boolean
  past_booking_count: number
  completed_count: number
  cancelled_count: number
  /** Most recent booking by date — what the customer most likely remembers. */
  last_booking:
    | {
        date: string
        service_name: string | null
        status: string
      }
    | null
  /** Rounded average party size across their history, for "back with the
   *  same group?" inference. Null when no usable signal. */
  typical_party_size: number | null
}

/**
 * Reduce raw booking rows to the summary fields Caye actually uses.
 * Returns a "not returning" zero state when rows is empty.
 */
export function summarizeBookingHistory(rows: BookingHistoryRow[]): CustomerHistorySummary {
  if (!rows.length) {
    return {
      is_returning: false,
      past_booking_count: 0,
      completed_count: 0,
      cancelled_count: 0,
      last_booking: null,
      typical_party_size: null,
    }
  }

  let completed = 0
  let cancelled = 0
  let totalGuests = 0
  let validParties = 0

  for (const r of rows) {
    if (r.status === 'completed') completed++
    else if (r.status === 'cancelled') cancelled++
    if (r.number_of_people > 0) {
      totalGuests += r.number_of_people
      validParties++
    }
  }

  // Latest by date — ties broken arbitrarily (rare, doesn't matter).
  const sortedDesc = [...rows].sort((a, b) =>
    a.booking_date < b.booking_date ? 1 : a.booking_date > b.booking_date ? -1 : 0
  )
  const latest = sortedDesc[0]

  return {
    is_returning: true,
    past_booking_count: rows.length,
    completed_count: completed,
    cancelled_count: cancelled,
    last_booking: {
      date: latest.booking_date,
      service_name: latest.service_name,
      status: latest.status,
    },
    typical_party_size: validParties > 0 ? Math.round(totalGuests / validParties) : null,
  }
}

/**
 * Render the CUSTOMER HISTORY prompt block. Returns empty string for
 * first-time customers — Caye opens normally with no preamble.
 */
export function formatCustomerHistoryBlock(summary: CustomerHistorySummary): string {
  if (!summary.is_returning) return ''

  const lines: string[] = []
  // Status breakdown
  const completedStr = summary.completed_count === 1 ? 'completed' : 'completed'
  const cancelledStr = summary.cancelled_count > 0
    ? `, ${summary.cancelled_count} cancelled`
    : ''
  lines.push(
    `- Past bookings: ${summary.completed_count} ${completedStr}${cancelledStr} ` +
      `(${summary.past_booking_count} total)`
  )

  if (summary.last_booking) {
    const svc = summary.last_booking.service_name ?? 'unknown service'
    lines.push(`- Last booking: ${summary.last_booking.date}, ${svc} (${summary.last_booking.status})`)
  }

  if (summary.typical_party_size && summary.typical_party_size > 0) {
    lines.push(`- Typical party size: ${summary.typical_party_size} guest(s)`)
  }

  return (
    'CUSTOMER HISTORY — this is a returning customer:\n' +
    lines.join('\n') +
    '\n' +
    "Acknowledge them as a returning customer naturally when it fits — \"welcome back\", " +
    "\"good to hear from you again\", etc. Don't restate this list to them. Don't re-ask " +
    "for info that's already in their history (party size, service preference) unless " +
    'they bring it up first. If their last booking was cancelled, be tactful — do not ' +
    'reference the cancellation unless they bring it up.'
  )
}
