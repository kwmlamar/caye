/**
 * When should a reminder actually fire, and is that a sane time to fire it?
 *
 * Pure and DB-free so the timezone arithmetic is unit-testable — same pattern
 * as schedule.ts's helpers, which this deliberately mirrors rather than
 * duplicates (localDateISO / endOfLocalDayUTC live there).
 *
 * WHY THIS EXISTS (2026-08-09)
 * Mrs. Max, at the end of three hours of clearing her queue: "are you able to
 * remind of meeting tomorrow for 8:30 and 9:30". She got "I'm not able to set
 * reminders — that's not something I can do yet, sorry."
 *
 * It was the only thing she asked for unprompted all session, which makes it
 * the clearest signal so far that she's starting to treat Caye as staff rather
 * than as an inbox. The machinery was already there: caye_outbound_queue has
 * scheduled_for and a worker that polls it.
 *
 * THE PART THAT NEEDS CARE
 * The operator says "8:30 tomorrow". That is a LOCAL time in the workspace's
 * timezone (Bimini is America/Nassau, UTC-4), and the queue stores an absolute
 * instant. Getting that conversion wrong doesn't error — it silently fires the
 * reminder four hours off, which is worse than not having the feature, because
 * she'd stop trusting it after one miss.
 */

/** Bounds on how far ahead a reminder may be scheduled. */
export const MIN_LEAD_MS = 60 * 1000 // a minute — anything less is "now"
export const MAX_LEAD_DAYS = 180

export type ReminderResolution =
  | { ok: true; fireAtUTC: Date; leadMinutes: number }
  | { ok: false; error: string }

/**
 * Convert a local wall-clock datetime to the UTC instant it refers to.
 *
 * Uses the same offset-probe technique as schedule.ts: format a candidate
 * instant in the target zone, measure how far it lands from the wall-clock we
 * wanted, and correct. Done twice, because the first correction can itself
 * cross a DST boundary.
 */
export function localDateTimeToUTC(dateISO: string, timeHHMM: string, timezone: string): Date {
  const [y, m, d] = dateISO.split('-').map(Number)
  const [hh, mm] = timeHHMM.split(':').map(Number)

  // First guess: treat the wall-clock as if it were UTC.
  let instant = Date.UTC(y, m - 1, d, hh, mm, 0)

  for (let i = 0; i < 2; i++) {
    const asSeen = wallClockInZone(new Date(instant), timezone)
    const wanted = Date.UTC(y, m - 1, d, hh, mm, 0)
    const drift = wanted - asSeen
    if (drift === 0) break
    instant += drift
  }

  return new Date(instant)
}

/** The wall-clock reading of `instant` in `timezone`, expressed as a UTC epoch. */
function wallClockInZone(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Validate and resolve an operator-supplied local date+time.
 *
 * Errors are written for the operator, not the developer — they get relayed
 * into WhatsApp verbatim when the model reports back.
 */
export function resolveReminderTime(args: {
  dateISO: string
  timeHHMM: string
  timezone: string
  now?: Date
}): ReminderResolution {
  const { dateISO, timeHHMM, timezone } = args
  const now = args.now ?? new Date()

  if (!ISO_DATE.test(dateISO)) {
    return { ok: false, error: `I need the date as YYYY-MM-DD — got "${dateISO}".` }
  }
  if (!HHMM.test(timeHHMM)) {
    return { ok: false, error: `I need the time as 24-hour HH:MM — got "${timeHHMM}".` }
  }

  let fireAtUTC: Date
  try {
    fireAtUTC = localDateTimeToUTC(dateISO, timeHHMM, timezone)
  } catch {
    return { ok: false, error: `I couldn't work out what "${dateISO} ${timeHHMM}" means locally.` }
  }
  if (Number.isNaN(fireAtUTC.getTime())) {
    return { ok: false, error: `"${dateISO} ${timeHHMM}" isn't a real date and time.` }
  }

  const leadMs = fireAtUTC.getTime() - now.getTime()
  if (leadMs < MIN_LEAD_MS) {
    return {
      ok: false,
      // Names the most likely cause. A reminder landing in the past is nearly
      // always a year/date slip, not an intent to fire immediately.
      error: `That time has already passed — check the date. If you meant today, say so and I'll take the next one.`,
    }
  }
  if (leadMs > MAX_LEAD_DAYS * 24 * 60 * 60 * 1000) {
    return { ok: false, error: `That's more than ${MAX_LEAD_DAYS} days out — too far ahead for me to hold.` }
  }

  return { ok: true, fireAtUTC, leadMinutes: Math.round(leadMs / 60000) }
}

/**
 * How the reminder reads when it lands. Prefixed so it's unmistakably a
 * reminder she asked for rather than Caye raising something new — an
 * unprompted-looking message at 8:30am reads as a fresh problem.
 */
export function formatReminderBody(message: string): string {
  const trimmed = message.replace(/\s+/g, ' ').trim()
  return `⏰ Reminder you asked me to set: ${trimmed}`.slice(0, 900)
}

/** Operator-facing confirmation, in their own local time. */
export function describeReminderTime(fireAtUTC: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(fireAtUTC)
}
