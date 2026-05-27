/**
 * Pure eligibility logic for the daily proactive-nudge scan. Extracted
 * from app/api/caye/nudge-scan so trigger windows + edge cases can be
 * unit tested without Supabase / Anthropic.
 *
 * Two nudge types in v1:
 *   - REVIEW REQUEST: 24h+ after a completed booking, max once per booking
 *   - GHOSTED LEAD: 3+ days after Caye's last reply on a thread that
 *     never produced a booking and the customer never responded to
 *
 * The cron endpoint does the Supabase querying + the actual nudge send.
 * These functions just decide "given this row, should we nudge now?"
 */

export const REVIEW_REQUEST_MIN_HOURS_AFTER_BOOKING = 24
export const GHOSTED_LEAD_MIN_DAYS_SILENCE = 3

// ── Review request ──────────────────────────────────────────────────────────

export interface ReviewCandidate {
  /** YYYY-MM-DD */
  booking_date: string
  status: string
  review_requested_at: string | null
  /** When the customer's last email/message was sent (for spam dedup) */
  last_contact_at?: string | null
}

/**
 * Should we send a post-tour review request for this booking?
 *
 * Conservative: requires (a) status='completed', (b) at least 24 hours
 * since the booking date wrapped up (we measure from end-of-day on the
 * booking date for simplicity — timezone-agnostic, slightly fuzzy on
 * the boundary, fine for daily-cron cadence), (c) no review already
 * requested.
 */
export function shouldSendReviewRequest(
  candidate: ReviewCandidate,
  now: Date
): boolean {
  if (candidate.status !== 'completed') return false
  if (candidate.review_requested_at) return false

  // Treat the booking as "wrapped up" 24h after end-of-day of booking_date.
  // i.e. for booking on 2026-05-30, we can nudge starting 2026-06-01 00:00 UTC.
  // Fuzzy by a few hours across timezones — acceptable at daily cadence.
  const endOfBookingDayUtc = Date.parse(`${candidate.booking_date}T23:59:59Z`)
  if (isNaN(endOfBookingDayUtc)) return false

  const msSinceEnd = now.getTime() - endOfBookingDayUtc
  const hoursSinceEnd = msSinceEnd / (1000 * 60 * 60)
  return hoursSinceEnd >= REVIEW_REQUEST_MIN_HOURS_AFTER_BOOKING
}

// ── Ghosted-lead nudge ──────────────────────────────────────────────────────

export interface GhostedLeadCandidate {
  /** Last message timestamp on the conversation. */
  last_message_at: string | null
  /** Most recent business-side sender kind: 'caye' (auto-reply) | 'human' | null */
  last_business_sender_kind: 'caye' | 'human' | null
  /** Type of the last sender — 'customer' or 'business'. Must be 'business'
   *  (Caye replied last and customer hasn't responded) to be eligible. */
  last_sender_type: 'customer' | 'business' | null
  /** Stamped when a nudge was previously sent — never nudge twice. */
  nudge_sent_at: string | null
  /** Number of bookings linked to this conversation. >0 means the customer
   *  did book, so we don't nudge (they're not "ghosted", they converted). */
  booking_count: number
  /** Conversation is held for owner — don't nudge over the owner's head. */
  human_agent_enabled: boolean
}

/**
 * Should we send a "still interested?" nudge to this conversation?
 *
 * Requires ALL of:
 * - Caye replied last (last_sender_type='business' AND last_business_sender_kind='caye')
 * - At least GHOSTED_LEAD_MIN_DAYS_SILENCE since last_message_at
 * - No booking ever created from this thread (booking_count == 0)
 * - No prior nudge sent on this conversation (nudge_sent_at is null)
 * - Not currently held for owner (human_agent_enabled is false)
 */
export function shouldSendGhostedLeadNudge(
  candidate: GhostedLeadCandidate,
  now: Date
): boolean {
  if (candidate.nudge_sent_at) return false
  if (candidate.human_agent_enabled) return false
  if (candidate.booking_count > 0) return false
  if (candidate.last_sender_type !== 'business') return false
  if (candidate.last_business_sender_kind !== 'caye') return false
  if (!candidate.last_message_at) return false

  const lastMs = Date.parse(candidate.last_message_at)
  if (isNaN(lastMs)) return false
  const daysSilent = (now.getTime() - lastMs) / (1000 * 60 * 60 * 24)
  return daysSilent >= GHOSTED_LEAD_MIN_DAYS_SILENCE
}

// ── Auto-complete sweep ─────────────────────────────────────────────────────

export interface AutoCompleteCandidate {
  status: string
  booking_date: string
  /** HH:MM 24-hour */
  booking_time: string
  duration_minutes: number | null
}

/**
 * Should we flip this confirmed booking to 'completed'?
 *
 * Conservative: only flip when the booking's end time has passed by at
 * least 6 hours. Avoids edge cases where the cron fires mid-tour on a
 * late-starting late-running booking. 6h fudge is plenty given the
 * daily cadence.
 *
 * Timezone-agnostic: we treat booking_date+booking_time as UTC, add
 * duration_minutes, add the 6h buffer. Fuzzy across timezones by a few
 * hours, fine for the auto-complete purpose.
 */
export function shouldAutoCompleteBooking(
  candidate: AutoCompleteCandidate,
  now: Date
): boolean {
  if (candidate.status !== 'confirmed' && candidate.status !== 'pending') return false

  const [hh, mm] = candidate.booking_time.split(':').map(Number)
  const startMs = Date.parse(`${candidate.booking_date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`)
  if (isNaN(startMs)) return false

  const duration = candidate.duration_minutes && candidate.duration_minutes > 0
    ? candidate.duration_minutes
    : 120 // sensible default for tour businesses

  const endMs = startMs + duration * 60 * 1000
  const bufferMs = 6 * 60 * 60 * 1000

  return now.getTime() >= endMs + bufferMs
}
