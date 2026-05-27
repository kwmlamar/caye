/**
 * Pure policy logic for the reschedule/cancel tools. Extracted from
 * caye-reply.ts so the autonomy boundary can be unit tested without
 * pulling in Supabase / Anthropic.
 *
 * Bimini's stated cancellation policy is "Full refund if cancelled
 * 48 hours before." We use that 48h window as Caye's autonomy boundary:
 * >= 48h out, she can act directly; < 48h out, she must hold for owner
 * because the business is now absorbing operational cost (last-minute
 * changes affect refunds, slot fills, prep work).
 *
 * The gate runs INSIDE the tools (defense in depth) — even if Caye
 * ignores the prompt and tries to cancel a same-day booking, the tool
 * refuses and forces a hold_for_human.
 */

export const AUTONOMY_WINDOW_HOURS = 48

export interface PolicyGateInput {
  /** Booking date in YYYY-MM-DD (local to the workspace's timezone). */
  bookingDate: string
  /** Booking time in HH:MM (24h). */
  bookingTime: string
  /** Workspace IANA timezone, e.g. "America/Nassau". */
  timezone: string
  /** Current time, defaults to now. Injected for tests. */
  now?: Date
}

export type PolicyGateResult =
  | { ok: true; hoursUntilBooking: number }
  | { ok: false; reason: 'within_policy_window'; hoursUntilBooking: number }
  | { ok: false; reason: 'booking_in_past'; hoursUntilBooking: number }

/**
 * Decide whether Caye is allowed to act unilaterally on this booking.
 *
 * Returns `ok: true` when the booking is >= 48 hours in the future.
 * Returns `ok: false, reason: 'within_policy_window'` when the booking
 * is within the next 48 hours (still future, but inside the policy
 * window — Karenda's decision, not Caye's).
 * Returns `ok: false, reason: 'booking_in_past'` when the booking has
 * already started or passed — Caye should never modify these.
 */
export function checkBookingAutonomy(input: PolicyGateInput): PolicyGateResult {
  const now = input.now ?? new Date()
  const bookingMs = bookingInstantMs(input.bookingDate, input.bookingTime, input.timezone)
  // Compare in integer milliseconds so the policy boundary is exact —
  // floating-point hours can land at 47.9999... at the exact 48h mark
  // and false-trigger the window.
  const diffMs = bookingMs - now.getTime()
  const windowMs = AUTONOMY_WINDOW_HOURS * 60 * 60 * 1000
  const hoursUntilBooking = diffMs / (1000 * 60 * 60) // for display only

  if (diffMs <= 0) {
    return { ok: false, reason: 'booking_in_past', hoursUntilBooking }
  }
  if (diffMs < windowMs) {
    return { ok: false, reason: 'within_policy_window', hoursUntilBooking }
  }
  return { ok: true, hoursUntilBooking }
}

/**
 * Resolve a "date + time + timezone" tuple to a UTC millisecond instant.
 * We need this because bookings.booking_date is a DATE (timezone-naive)
 * and booking_time is a TIME (timezone-naive) — together they represent
 * "10:00 on June 3rd in the workspace's local timezone", which can be
 * many different UTC moments depending on the workspace.
 *
 * Approach: format the candidate UTC moment back into the workspace's
 * timezone using Intl.DateTimeFormat, then adjust until the formatted
 * wall-clock matches the input. One pass is enough for our purposes
 * because we don't hit DST transitions for non-DST Caribbean timezones,
 * but we loop twice for safety against US/EU timezones (Karenda is
 * America/Nassau which doesn't observe DST, but other workspaces might).
 */
function bookingInstantMs(date: string, time: string, timezone: string): number {
  // Start with the naive interpretation (treat as UTC) and correct.
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  let utcGuess = Date.UTC(y, m - 1, d, hh, mm)

  for (let pass = 0; pass < 2; pass++) {
    const offsetMs = timezoneOffsetMs(utcGuess, timezone)
    utcGuess = Date.UTC(y, m - 1, d, hh, mm) - offsetMs
  }
  return utcGuess
}

/**
 * For a given UTC instant, returns how many ms the named timezone is
 * ahead of UTC. America/Nassau in winter = -5h = -18,000,000 ms.
 */
function timezoneOffsetMs(utcMs: number, timezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = dtf.formatToParts(new Date(utcMs))
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0)
  const localAsUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') === 24 ? 0 : get('hour'), get('minute'), get('second')
  )
  return localAsUtc - utcMs
}
