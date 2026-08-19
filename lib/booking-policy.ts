import { zonedInstantMs } from './booking-time'

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
  const bookingMs = zonedInstantMs(input.bookingDate, input.bookingTime, input.timezone)
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
