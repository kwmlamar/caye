import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'

export type BookingStatusClaim =
  | 'pending'
  | 'confirmed'
  | 'cancelled'
  | 'completed'
  | 'refunded'
  | 'held'

const THIRD_PARTY_COMMIT = /\b(?:coordinate[sd]?|coordinating|arrange[sd]?|arranging|set(?:s|ting)?\s+up|book(?:ed|s|ing)?|organiz(?:e[sd]?|ing)|handle[sd]?|handling|take\s+care\s+of|line[sd]?\s+up|lining\s+up)\b/i
const THIRD_PARTY_NOUN = /\b(?:(?:trusted\s+)?partners?|vendors?|affiliates?|third[- ]part(?:y|ies)|outside\s+(?:company|companies|operator|vendor)|another\s+(?:company|operator|provider)|local\s+operators?|tour\s+operators?|dive\s+(?:shop|operator|company)|charter\s+(?:company|operator|boat)|snuba|snorkel(?:l?ing)?)\b/i
const REFUND = /\b(?:refund(?:ed|ing|s)?|reimburse(?:d|ment|s)?|money\s+back)\b/i
const NEGATION = /\b(?:do\s+not|don't|does\s+not|doesn't|cannot|can't|never|no|not\s+available|not\s+offered|not\s+eligible|won't|will\s+not)\b/i

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * CAY-97: concept overlap is not semantic agreement. A grounding sentence
 * that says "we do not offer refunds" must never authorize "we will refund
 * you", and a sentence saying the business does not coordinate snorkeling
 * cannot authorize the opposite partner commitment.
 */
export function detectConsequentialPolarityConflict(
  content: string,
  groundingText: string
): string | null {
  const grounding = sentences(groundingText)

  for (const sentence of sentences(content)) {
    const affirmativeThirdParty = THIRD_PARTY_COMMIT.test(sentence) && THIRD_PARTY_NOUN.test(sentence) && !NEGATION.test(sentence)
    if (affirmativeThirdParty) {
      const contradictory = grounding.find(
        (g) => NEGATION.test(g) && THIRD_PARTY_COMMIT.test(g) && THIRD_PARTY_NOUN.test(g)
      )
      if (contradictory) {
        return `third-party commitment contradicts authoritative grounding ("${contradictory}")`
      }
    }

    const affirmativeRefund = REFUND.test(sentence) && !NEGATION.test(sentence)
    if (affirmativeRefund) {
      const contradictory = grounding.find((g) => NEGATION.test(g) && REFUND.test(g))
      if (contradictory) {
        return `refund commitment contradicts authoritative grounding ("${contradictory}")`
      }
    }
  }

  return null
}

export function extractBookingStatusClaims(text: string): BookingStatusClaim[] {
  const claims = new Set<BookingStatusClaim>()
  for (const sentence of sentences(text)) {
    const aboutBooking = /\b(?:booking|reservation)\b/i.test(sentence)
    if (!aboutBooking) continue

    if (/\b(?:confirmed|confirmation)\b/i.test(sentence)) claims.add('confirmed')
    if (/\b(?:pending)\b/i.test(sentence)) claims.add('pending')
    if (/\b(?:cancelled|canceled|cancellation)\b/i.test(sentence)) claims.add('cancelled')
    if (/\b(?:completed|complete)\b/i.test(sentence)) claims.add('completed')
    if (/\b(?:refunded|refund(?:ed)?)\b/i.test(sentence)) claims.add('refunded')
    if (/\b(?:on\s+hold|held)\b/i.test(sentence)) claims.add('held')
  }
  return [...claims]
}

function normalizeStatus(value: string): BookingStatusClaim | null {
  const v = value.trim().toLowerCase()
  if (v === 'canceled' || v === 'cancelled') return 'cancelled'
  if (v === 'complete' || v === 'completed') return 'completed'
  if (v === 'confirmed' || v === 'pending' || v === 'refunded' || v === 'held') return v
  return null
}

export interface BookingStatusEvidence {
  statuses: string[]
  ownerInstructionText?: string
}

/** Pure decision layer, split from DB loading so the invariants are unit-testable. */
export function validateBookingStatusClaimsAgainstEvidence(
  content: string,
  evidence: BookingStatusEvidence
): string | null {
  const claims = extractBookingStatusClaims(content)
  if (claims.length === 0) return null

  const ownerClaims = new Set(extractBookingStatusClaims(evidence.ownerInstructionText ?? ''))
  const authoritative = new Set(
    evidence.statuses.map(normalizeStatus).filter((s): s is BookingStatusClaim => s !== null)
  )

  for (const claim of claims) {
    // Explicit operator-approved instruction on this thread is a scoped
    // authority override, as required by #97.
    if (ownerClaims.has(claim)) continue

    if (authoritative.size === 0) {
      return `claims booking status "${claim}" but no authoritative booking row or scoped owner instruction supports it`
    }
    if (authoritative.size > 1) {
      return `claims booking status "${claim}" but authoritative booking state is ambiguous/conflicting (${[...authoritative].join(', ')})`
    }
    const [actual] = [...authoritative]
    if (actual !== claim) {
      return `claims booking status "${claim}" but authoritative booking status is "${actual}"`
    }
  }
  return null
}

/**
 * Only operator-authorized customer-facing messages count as scoped owner
 * instruction. Autonomous Caye messages are deliberately excluded so an old
 * hallucination cannot become evidence for a new one.
 */
export async function fetchScopedOwnerInstructionText(
  db: ReturnType<typeof createServiceClient>,
  conversationId: string
): Promise<string> {
  const { data } = await db
    .from('unified_messages')
    .select('content,metadata')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'business')
    .eq('is_internal', false)
    .order('sent_at', { ascending: true })
    .limit(100)

  return (data ?? [])
    .filter((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>
      const sentBy = typeof meta.sent_by === 'string' ? meta.sent_by : ''
      return sentBy === 'caye-operator-wa' || sentBy === 'caye-dashboard'
    })
    .map((row) => row.content || '')
    .filter(Boolean)
    .join('\n')
}

export async function validateAuthoritativeBookingStatusClaims(
  db: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  conversationId: string,
  content: string,
  ownerInstructionText?: string
): Promise<string | null> {
  const claims = extractBookingStatusClaims(content)
  if (claims.length === 0) return null

  // Exact thread linkage is the strongest identity available. New bookings
  // already persist conversation_id; legacy rows fall back to verified contact
  // identity only when no thread-linked rows exist.
  const direct = await db
    .from('bookings')
    .select('status')
    .eq('user_id', workspaceId)
    .eq('conversation_id', conversationId)

  let statuses = (direct.data ?? []).map((r) => String(r.status ?? '')).filter(Boolean)

  if (statuses.length === 0) {
    const { data: conv } = await db
      .from('unified_conversations')
      .select('customer_name,customer_id,contact_id,channel_type')
      .eq('id', conversationId)
      .maybeSingle()

    let email: string | null = null
    let phone: string | null = null
    let name: string | null = (conv?.customer_name as string | null) ?? null

    if (conv?.contact_id) {
      const { data: contact } = await db
        .from('contacts')
        .select('name,email,phone_number')
        .eq('id', conv.contact_id)
        .maybeSingle()
      email = (contact?.email as string | null) ?? null
      phone = (contact?.phone_number as string | null) ?? null
      name = (contact?.name as string | null) ?? name
    }

    const customerId = (conv?.customer_id as string | null) ?? null
    if (!email && customerId?.includes('@')) email = customerId
    if (!phone && customerId && !customerId.includes('@')) phone = customerId

    if (email) {
      const res = await db.from('bookings').select('status').eq('user_id', workspaceId).ilike('customer_email', email)
      statuses = (res.data ?? []).map((r) => String(r.status ?? '')).filter(Boolean)
    }
    if (statuses.length === 0 && phone) {
      const res = await db.from('bookings').select('status').eq('user_id', workspaceId).eq('customer_phone', phone)
      statuses = (res.data ?? []).map((r) => String(r.status ?? '')).filter(Boolean)
    }
    if (statuses.length === 0 && name) {
      // Manual calendar/import bookings commonly keep useful qualifiers in
      // customer_name (for example, "Name (2) Private"). Treat the thread
      // name as a conservative substring fallback, matching findBookings.
      const res = await db
        .from('bookings')
        .select('status')
        .eq('user_id', workspaceId)
        .ilike('customer_name', `%${name}%`)
      statuses = (res.data ?? []).map((r) => String(r.status ?? '')).filter(Boolean)
    }
  }

  return validateBookingStatusClaimsAgainstEvidence(content, {
    statuses,
    ownerInstructionText,
  })
}

// ============================================================================
// Booking TIME grounding (2026-08-26 Sonja Pettus incident)
//
// An operator told Caye to move a tour from 9:00 a.m. to 10:00 a.m. Caye
// sent the customer a message saying the tour was now at 10:00 a.m. — but
// never called reschedule_booking, so the authoritative bookings.booking_time
// row stayed at 9:00 a.m. A payment-confirmation message sent four seconds
// later read the same stale 9:00 a.m. back to the customer.
//
// Deliberately UNLIKE validateBookingStatusClaimsAgainstEvidence above, this
// check has NO scoped-owner-instruction override. The whole point of the
// incident is that the operator SAYING the time changed is not evidence the
// booking record changed — communication must never substitute for the
// mutation. Only an actual reschedule_booking call (or the record already
// matching) can ground a time claim.
// ============================================================================

const TOUR_TIME = String.raw`(?:\d{1,2}:[0-5]\d(?:\s*(?:a\.?m\.?|p\.?m\.?))?|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?))`

/**
 * "10:00 a.m." / "9am" / "09:00" -> "10:00" 24h, or null if unparseable /
 * genuinely ambiguous (a bare single-digit hour with no am/pm and no
 * leading zero, e.g. a lone "9:00" with nothing to disambiguate — real
 * tour copy in this codebase always carries either am/pm or the
 * leading-zero 24h form booking_time.slice(0,5) produces).
 */
function to24Hour(raw: string): string | null {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?$/)
  if (!m) return null
  let hour = parseInt(m[1], 10)
  const minute = m[2] ? parseInt(m[2], 10) : 0
  if (m[3]) {
    const meridiem = m[3].replace(/\./g, '')
    if (hour < 1 || hour > 12) return null
    if (meridiem === 'pm' && hour !== 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
  } else if (!/^\d{2}$/.test(m[1]) || hour > 23) {
    return null
  }
  if (hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * Extracts "the tour is at HH:MM" claims — a time near the word "tour" in
 * the same sentence, EXCLUDING a time explicitly marked as the prior value
 * ("...to 10 a.m. rather than 9 a.m.", "updated time from 9 a.m.") so a
 * legitimate correction message doesn't flag its own old-time context as an
 * ungrounded claim.
 */
export function extractTourTimeClaims(text: string): string[] {
  const claims = new Set<string>()
  for (const sentence of text.split(/\n|(?<=[.!?])\s+/)) {
    if (!/\btour\b/i.test(sentence)) continue
    const timeRe = new RegExp(TOUR_TIME, 'gi')
    let match: RegExpExecArray | null
    while ((match = timeRe.exec(sentence)) !== null) {
      const before = sentence.slice(Math.max(0, match.index - 20), match.index).toLowerCase()
      if (/(?:rather than|instead of|from|previously|was)\s*$/.test(before)) continue
      const canonical = to24Hour(match[0])
      if (canonical) claims.add(canonical)
    }
  }
  return [...claims]
}

/** Pure decision layer, split from DB loading so the invariant is unit-testable. */
export function validateBookingTimeClaimsAgainstEvidence(
  content: string,
  bookingTime: string | null
): string | null {
  const claims = extractTourTimeClaims(content)
  if (claims.length === 0) return null
  if (!bookingTime) return null // no linked booking with a time on record — nothing to contradict

  const actual = to24Hour(bookingTime.slice(0, 5))
  if (!actual) return null

  for (const claim of claims) {
    if (claim !== actual) {
      return `claims the tour time is "${claim}" but the authoritative booking record still shows "${actual}"`
    }
  }
  return null
}

/**
 * Loads the authoritative booking_time for the SINGLE booking linked to
 * this conversation (by conversation_id, excluding cancelled). Deliberately
 * conservative: if zero or more than one booking matches, returns null
 * (skip the check) rather than falling back to name/email/phone matching —
 * unlike the status check above, a time mismatch is specific enough that a
 * wrong-booking false positive would incorrectly block a legitimate send,
 * and the conversation_id link already covers the case this incident
 * actually happened in.
 */
export async function fetchAuthoritativeBookingTime(
  db: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  conversationId: string
): Promise<string | null> {
  const { data } = await db
    .from('bookings')
    .select('booking_time')
    .eq('user_id', workspaceId)
    .eq('conversation_id', conversationId)
    .neq('status', 'cancelled')

  const rows = data ?? []
  if (rows.length !== 1) return null
  return (rows[0].booking_time as string | null) ?? null
}

export async function validateAuthoritativeBookingTimeClaims(
  db: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  conversationId: string,
  content: string
): Promise<string | null> {
  if (extractTourTimeClaims(content).length === 0) return null
  const bookingTime = await fetchAuthoritativeBookingTime(db, workspaceId, conversationId)
  return validateBookingTimeClaimsAgainstEvidence(content, bookingTime)
}
