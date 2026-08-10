/**
 * Pure decision logic for retiring a caye_escalations row, and for naming
 * the contact in the note that retirement writes. Kept free of server-only
 * deps so it unit-tests without pulling in Supabase/Anthropic — same pattern
 * as autosend-gate.ts and inbound-classifier.ts. The DB reads live in
 * escalation-followup.ts.
 */

/**
 * Should a passed target_date actually retire this escalation?
 *
 * target_date is the date the *inbound question* was about, which is not
 * always the date the *relationship* is about. Emily Sherman (2026-08-09)
 * asked on Aug 9 whether she could still get a golf cart; the escalation
 * took target_date = Aug 9. She also had a confirmed private tour on Aug 20
 * — $645, three guests, still waiting on a start time, and as it turned out
 * a date conflict. At 20:00 on Aug 9 the hourly cron saw a passed
 * target_date, logged "letting this go", cleared the hold, and dropped her
 * from get_held_queue. Twenty minutes later Caye told the owner her queue
 * was empty. It was not: the owner found Emily herself, and the conflict was
 * still unresolved.
 *
 * So: a passed target_date only means "this particular question is moot". It
 * never means the contact is done with us. Any later commitment — a future
 * booking on the same thread — keeps the row open, because that later date
 * is the one somebody is still waiting on.
 */
export function shouldExpireOnTargetDate(args: {
  targetDate: string | null
  todayISO: string
  /** Latest non-cancelled booking date on this conversation, 'YYYY-MM-DD'. */
  latestBookingDate: string | null
}): boolean {
  const { targetDate, todayISO, latestBookingDate } = args
  if (!targetDate || targetDate >= todayISO) return false
  // A future (or same-day) booking outranks the stale question date.
  if (latestBookingDate && latestBookingDate >= todayISO) return false
  return true
}

/**
 * Sentinel returned by the booking lookup when the read itself failed, so a
 * DB blip reads as "something is still ahead" and holds the row open. Losing
 * a day of nagging is recoverable; silently retiring a live booking is the
 * failure this module exists to prevent.
 */
export const BOOKING_LOOKUP_FAILED = '9999-12-31'

