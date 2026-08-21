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
      const res = await db.from('bookings').select('status').eq('user_id', workspaceId).ilike('customer_name', name)
      statuses = (res.data ?? []).map((r) => String(r.status ?? '')).filter(Boolean)
    }
  }

  return validateBookingStatusClaimsAgainstEvidence(content, {
    statuses,
    ownerInstructionText,
  })
}
