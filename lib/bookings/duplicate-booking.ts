/**
 * Would this new booking be the same booking we already have?
 *
 * WHY THIS EXISTS (2026-08-11)
 * Karin Roberts is on Karenda's calendar twice for November 6th:
 *
 *   08-06 21:56  Karin Roberts, 2026-11-06 09:00, 2 guests  [Caye create]
 *                "Shared tour. Guest saw Max in a video and specifically
 *                 requested him."
 *   08-08 00:06  Karin Roberts, 2026-11-06 09:00, 2 guests  [Caye create]
 *                "Shared Heritage Tour for 2 adults... Arriving via cruise
 *                 ship (Star Princess)."
 *
 * Same person, same email, same thread, same date, same time, same party —
 * two separate Zoho calendar events. The guest came back with more detail two
 * days later and Caye booked her a second time. Karenda's calendar reads as 4
 * guests for a party of 2, which is how a tour gets overbooked on paper and
 * how a day looks full when it isn't.
 *
 * createBookingFromCaye ran a bare insert with no check of any kind. This is
 * that check.
 *
 * DELIBERATELY REFUSES RATHER THAN MERGING. A second booking for one person on
 * one day is occasionally real — two different tours, a morning and an
 * afternoon. So this does not silently drop the request or overwrite the first
 * row; it hands the existing booking back so Caye has to say something about
 * it. Same shape as resolveTier holding on an ambiguous group size: when the
 * data supports two readings, stop and surface, never guess.
 */

/** An active booking already on file, as far as duplicate detection cares. */
export interface ExistingBooking {
  id: string
  customer_name: string | null
  customer_email: string | null
  booking_date: string
  booking_time: string | null
  number_of_people: number | null
  status: string | null
}

export interface CandidateBooking {
  customer_name: string
  customer_email: string | null
  booking_date: string
}

export type DuplicateVerdict =
  | { duplicate: false }
  | { duplicate: true; existing: ExistingBooking; matchedBy: 'email' | 'name'; message: string }

/** Cancelled bookings are history and must never block a rebooking. */
const ACTIVE_STATUSES = new Set(['pending', 'confirmed'])

const normEmail = (v: string | null | undefined) => v?.trim().toLowerCase() || null
const normName = (v: string | null | undefined) => v?.trim().toLowerCase().replace(/\s+/g, ' ') || null

/**
 * Find an active booking that is, on the evidence, the same booking.
 *
 * Identity is email when both sides have one — the reliable key. Name is the
 * fallback and is only trusted when NEITHER side has an email to contradict
 * it: two different guests called "John Smith" on the same day is far-fetched,
 * but "same name, different email" is a genuinely different person and must
 * not be collapsed.
 *
 * Time is deliberately NOT part of the match. Caye had booked Karin at the
 * same time twice, but a duplicate created at a different hour is still a
 * duplicate, and requiring the times to agree would have missed it.
 */
export function findDuplicateBooking(args: {
  existing: ExistingBooking[]
  candidate: CandidateBooking
}): DuplicateVerdict {
  const { existing, candidate } = args
  const candEmail = normEmail(candidate.customer_email)
  const candName = normName(candidate.customer_name)

  for (const row of existing) {
    if (!ACTIVE_STATUSES.has((row.status ?? '').toLowerCase())) continue
    if (row.booking_date !== candidate.booking_date) continue

    const rowEmail = normEmail(row.customer_email)
    const rowName = normName(row.customer_name)

    let matchedBy: 'email' | 'name' | null = null
    if (candEmail && rowEmail) {
      if (candEmail === rowEmail) matchedBy = 'email'
    } else if (!candEmail && !rowEmail && candName && rowName && candName === rowName) {
      matchedBy = 'name'
    }
    if (!matchedBy) continue

    return {
      duplicate: true,
      existing: row,
      matchedBy,
      message: describeDuplicate(row, matchedBy),
    }
  }

  return { duplicate: false }
}

/**
 * Written for the model to act on, not for a log. It has to be obvious that
 * the right next move is to talk about the existing booking — amend it, or
 * confirm the guest really wants a second one — rather than retry the insert.
 */
function describeDuplicate(row: ExistingBooking, matchedBy: 'email' | 'name'): string {
  const who = row.customer_name?.trim() || 'this guest'
  const when = row.booking_time ? `${row.booking_date} at ${row.booking_time.slice(0, 5)}` : row.booking_date
  const party = row.number_of_people ? `, ${row.number_of_people} guest${row.number_of_people === 1 ? '' : 's'}` : ''
  const how = matchedBy === 'email' ? 'same email address' : 'same name, and neither booking has an email'

  return (
    `${who} already has a ${row.status ?? 'active'} booking on ${when}${party} (${how}). ` +
    `I did NOT create a second one. If this is the same trip, update that booking ` +
    `(reschedule_booking, or ask the owner to change the party size) instead of making ` +
    `a new one. Only book again if the guest genuinely wants a separate second tour that ` +
    `day — and say so plainly if you do.`
  )
}
