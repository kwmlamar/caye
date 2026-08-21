/**
 * Shared deterministic business-local time utility.
 *
 * WHY THIS EXISTS (CAY-91, 2026-08-18 incident)
 * On Aug 18 (business-local), Caye told an owner that a customer's Aug 19
 * tour had already passed and treated it as cancelled/follow-up territory —
 * it was tomorrow, still active. Root cause: the owner-facing chat path had
 * no deterministic "today" anchor at all, and the read tools that DO exist
 * handed the model raw `booking_date` + `status` and left it to work out
 * past/today/tomorrow/upcoming itself, in UTC, by memory. Booking-critical
 * date state must never depend on free-form model arithmetic.
 *
 * `lib/booking-policy.ts` already had the right pattern (Intl.DateTimeFormat
 * resolving a workspace's local date+time+timezone to a real UTC instant)
 * for the write-side 48h cancellation gate. This module generalizes that
 * pattern — resolving business-local "now" and classifying booking dates
 * against it — so every read/report/prompt path can share it instead of
 * each re-deriving "today" its own (usually UTC-naive) way.
 *
 * `bookings.booking_date` is already stored as the workspace's local
 * calendar date (a naive DATE column — see PolicyGateInput in
 * booking-policy.ts), so classifying it only requires resolving "now" into
 * the same business-local calendar date and comparing the two date strings.
 * No conversion of booking_date itself is needed or performed here.
 */

export type BookingRelativeStatus = 'past' | 'today' | 'tomorrow' | 'upcoming'

/**
 * Resolve a "date + time + timezone" tuple to a UTC millisecond instant.
 * Moved from booking-policy.ts (2026-08-18) so both the write-side policy
 * gate and read-side temporal classification share one implementation
 * instead of two copies drifting apart.
 *
 * We need this because bookings.booking_date is a DATE (timezone-naive)
 * and booking_time is a TIME (timezone-naive) — together they represent
 * "10:00 on June 3rd in the workspace's local timezone", which can be
 * many different UTC moments depending on the workspace.
 *
 * Approach: format the candidate UTC moment back into the workspace's
 * timezone using Intl.DateTimeFormat, then adjust until the formatted
 * wall-clock matches the input. One pass is enough for most cases, but we
 * loop twice for safety against DST-observing timezones.
 */
export function zonedInstantMs(date: string, time: string, timezone: string): number {
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
export function timezoneOffsetMs(utcMs: number, timezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = dtf.formatToParts(new Date(utcMs))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const localAsUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') === 24 ? 0 : get('hour'), get('minute'), get('second')
  )
  return localAsUtc - utcMs
}

/**
 * The workspace's current calendar date, YYYY-MM-DD, in ITS timezone —
 * not the server's / UTC's. This is the authoritative "today" for every
 * booking/date comparison.
 */
export function businessLocalDate(timezone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD directly, matching booking_date's shape.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/**
 * Human-readable "TODAY'S DATE" anchor for a system prompt, resolved in the
 * workspace's own timezone (not UTC — the prior front-desk-only anchor,
 * `situation.ts`'s `todaysDateLabel`, formats in UTC regardless of the
 * workspace's real timezone, which is its own known-incomplete state).
 */
export function businessTodayLabel(timezone: string, now: Date = new Date()): string {
  const date = businessLocalDate(timezone, now)
  const spelled = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(now)
  return (
    `TODAY'S DATE (business-local, ${timezone}): ${date} (${spelled}). ` +
    `This is the authoritative "today" for every past/today/tomorrow/upcoming judgment about a booking or date — ` +
    `resolve it from this, never from memory, training-data assumptions, or your own arithmetic.`
  )
}

/** Calendar-day difference between two YYYY-MM-DD dates (toDate - fromDate). */
function calendarDayDiff(fromDate: string, toDate: string): number {
  const [fy, fm, fd] = fromDate.split('-').map(Number)
  const [ty, tm, td] = toDate.split('-').map(Number)
  const fromMs = Date.UTC(fy, fm - 1, fd)
  const toMs = Date.UTC(ty, tm - 1, td)
  return Math.round((toMs - fromMs) / 86_400_000)
}

/**
 * Classify a booking's local calendar date relative to the business's
 * local "today" — deterministically, no LLM arithmetic. Deliberately takes
 * ONLY dates, never a booking's workflow `status`: temporal position and
 * cancellation/completion status are separate concepts, and this function
 * has no way to conflate them because it never sees status at all.
 */
export function classifyBookingDate(bookingLocalDate: string, businessTodayDate: string): BookingRelativeStatus {
  const diffDays = calendarDayDiff(businessTodayDate, bookingLocalDate)
  if (diffDays < 0) return 'past'
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'tomorrow'
  return 'upcoming'
}

export interface BookingTemporal {
  /** The business's local "today" this was classified against. */
  businessToday: string
  bookingLocalDate: string
  relative: BookingRelativeStatus
}

/** Convenience wrapper: resolve business-local "today" and classify one booking date in one call. */
export function describeBookingTemporal(input: {
  bookingDate: string
  timezone: string
  now?: Date
}): BookingTemporal {
  const businessToday = businessLocalDate(input.timezone, input.now ?? new Date())
  return {
    businessToday,
    bookingLocalDate: input.bookingDate,
    relative: classifyBookingDate(input.bookingDate, businessToday),
  }
}

/**
 * Detect a genuine status/date conflict worth surfacing to the owner rather
 * than silently resolving. Today's one concrete source: bookings can be
 * auto-flipped to `completed` by a date-based sweep (lib/nudge-eligibility.ts)
 * using its own (UTC-naive) date math — independent of this module's
 * business-local classification. When that sweep's conclusion ("this already
 * happened") disagrees with the deterministic business-local calendar
 * ("this hasn't happened yet"), that is a real data conflict, not something
 * to paper over by picking one side.
 *
 * Deliberately does NOT flag `cancelled` as a conflict at any relative
 * status — cancellation is an explicit human/business decision, not a
 * date-derived one, and a future cancelled booking is exactly as valid as a
 * past one. Only `completed`, which IS date-derived, can conflict with the
 * date it was derived from.
 */
export function bookingStatusConflict(status: string, relative: BookingRelativeStatus): boolean {
  return status === 'completed' && relative !== 'past'
}
