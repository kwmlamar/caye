import type { PaymentDirection, PaymentSignal } from './types'

/**
 * Deterministic, evidence-bearing gate for "does this email say money arrived
 * for ODS" — mirrors lib/freight/detection.ts's shape (a document mention by
 * itself is not freight; a dollar figure by itself is not a payment).
 *
 * THE FALSE-POSITIVE THIS EXISTS TO AVOID
 *
 * A bare amount-regex match anywhere in the body fires on quoted figures,
 * signatures, forwarded estimates, and — critically — a SUPPLIER invoicing
 * ODS ("invoice attached, $4,200 due net 30"). That is money ODS owes, the
 * opposite direction from a client payment arriving. So an amount only
 * counts if it sits near an inbound-payment phrase (wired/deposited/
 * received, not just "sent" or "paid" in isolation, which read equally well
 * in either direction), and an outbound accounts-payable phrase nearby wins
 * over it rather than the other way around.
 */

const AMOUNT_SRC = '(?:US\\$|B\\$|BSD\\s?|\\$)\\s?(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|\\d+(?:\\.\\d{2})?)'
const AMOUNT_RE_G = new RegExp(AMOUNT_SRC, 'g')

// Deliberately compound phrases, not single words — "sent"/"paid"/"received"
// alone read equally well as "we sent you the invoice" or "payment must be
// paid". Each pattern here names money already having moved TO the recipient.
const INBOUND_SRC =
  '\\b(?:' +
  'wire[d]?\\s+(?:the\\s+|your\\s+|our\\s+)?(?:money|funds|payment|deposit|amount)|' +
  '(?:sent|made|issued)\\s+(?:the\\s+|a\\s+|your\\s+|our\\s+)?(?:wire|transfer|payment|deposit)|' +
  'payment\\s+(?:has\\s+been\\s+|was\\s+)?(?:sent|made|received|deposited|processed|issued)|' +
  '(?:deposit|credit)(?:ed)?\\s+(?:of|to|into)|' +
  'incoming\\s+wire|' +
  'you\\s+have\\s+received|' +
  'funds?\\s+(?:have\\s+been\\s+)?received|' +
  'we\\s+(?:have\\s+)?(?:just\\s+)?(?:wired|transferred|remitted)|' +
  'i\\s+(?:have\\s+)?(?:just\\s+)?(?:wired|transferred|remitted)|' +
  'wire\\s+transfer\\s+(?:notification|alert|confirmation)|' +
  'deposit\\s+notification|' +
  'transaction\\s+alert.{0,20}credit' +
  ')\\b'
const INBOUND_RE_G = new RegExp(INBOUND_SRC, 'gi')

// Accounts-payable language: ODS owes this, it did not just arrive.
const OUTBOUND_SRC =
  '\\b(?:' +
  'please\\s+(?:remit|pay)|' +
  'amount\\s+due|' +
  'balance\\s+due|' +
  'invoice\\s+(?:attached|enclosed)|' +
  'payment\\s+(?:is\\s+)?due|' +
  'net\\s*\\d{2}|' +
  'please\\s+find\\s+(?:attached|enclosed)\\s+(?:our\\s+|the\\s+)?invoice|' +
  'remittance\\s+(?:is\\s+)?due|' +
  'kindly\\s+settle|' +
  'outstanding\\s+balance' +
  ')\\b'
const OUTBOUND_RE_G = new RegExp(OUTBOUND_SRC, 'gi')

const REFERENCE_RE = /\b(?:invoice|inv|reference|ref|confirmation|conf)\.?\s*#?\s*[:\-]?\s*([A-Z0-9][A-Z0-9-]{2,})\b/i

/**
 * How close (in characters of the normalized text) an amount must sit to an
 * inbound/outbound phrase to count as "about" it, rather than merely present
 * somewhere in the same email.
 */
const PROXIMITY_WINDOW = 100

/**
 * Best-effort bank sender allowlist for the brief's "highest confidence"
 * source. Not load-bearing for the gate itself (a client's own "we wired it"
 * email is just as valid a signal) — only used to label the proposal.
 */
const BANK_SENDER_DOMAINS = [
  'rbc.com',
  'rbcroyalbank.com',
  'royalbank.com',
  'cibc.com',
  'cibcfcib.com',
  'cibcfirstcaribbean.com',
  'firstcaribbeanbank.com',
]

function senderName(from: string | null | undefined): string | null {
  if (!from) return null
  const before = from.split('<')[0].trim().replace(/^['"]|['"]$/g, '')
  return before && !before.includes('@') ? before : null
}

function senderEmailOf(from: string | null | undefined): string | null {
  if (!from) return null
  return from.match(/<?([\w.+-]+@[\w.-]+)>?/i)?.[1]?.toLowerCase() ?? null
}

function parseAmount(raw: string): number {
  return Number(raw.replace(/,/g, ''))
}

function nearestDistance(index: number, positions: number[]): number {
  if (positions.length === 0) return Infinity
  return Math.min(...positions.map((p) => Math.abs(p - index)))
}

/** Deterministic, evidence-bearing gate. A dollar figure by itself is not a payment. */
export function detectPaymentSignal(input: {
  subject?: string | null
  body?: string | null
  from?: string | null
}): PaymentSignal {
  const text = `${input.subject ?? ''}\n${input.body ?? ''}`.replace(/\s+/g, ' ').trim()
  const email = senderEmailOf(input.from)
  const domain = email?.split('@')[1]?.toLowerCase() ?? null
  const isBankSender = domain ? BANK_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`)) : false

  const amounts = [...text.matchAll(AMOUNT_RE_G)].map((m) => ({ index: m.index ?? 0, value: parseAmount(m[1]) }))
  const inboundPositions = [...text.matchAll(INBOUND_RE_G)].map((m) => m.index ?? 0)
  const outboundPositions = [...text.matchAll(OUTBOUND_RE_G)].map((m) => m.index ?? 0)

  const evidence: string[] = []
  if (inboundPositions.length > 0) evidence.push('inbound_language')
  if (outboundPositions.length > 0) evidence.push('outbound_language')
  if (isBankSender) evidence.push(`bank_sender:${domain}`)

  // Among every amount that qualifies (an inbound phrase closer than any
  // outbound one, within the window), pick the CLOSEST pairing overall —
  // not the first amount in document order. Two figures in the same email
  // (an older settled invoice, then "we wired $X for a different one") can
  // each sit within the window of some inbound phrase; only the tightest
  // binding should count as what the wire was actually for.
  let amount: number | null = null
  let bestDist = Infinity
  for (const a of amounts) {
    const inboundDist = nearestDistance(a.index, inboundPositions)
    const outboundDist = nearestDistance(a.index, outboundPositions)
    const qualifiesInbound = inboundDist <= PROXIMITY_WINDOW && inboundDist < outboundDist
    if (qualifiesInbound && inboundDist < bestDist) {
      amount = a.value
      bestDist = inboundDist
    }
  }
  if (amount !== null) evidence.push(`amount_near_inbound_phrase:${amount}`)

  let direction: PaymentDirection = 'unknown'
  if (amount !== null) direction = 'inbound'
  else if (outboundPositions.length > 0) direction = 'outbound'

  const reference = text.match(REFERENCE_RE)?.[1] ?? null
  if (reference) evidence.push(`reference:${reference}`)

  const isPaymentSignal = direction === 'inbound' && amount !== null && amount > 0

  return {
    isPaymentSignal,
    direction,
    amount: isPaymentSignal ? amount : null,
    reference,
    senderName: senderName(input.from),
    senderEmail: email,
    senderDomain: domain,
    isBankSender,
    evidence: isPaymentSignal ? evidence : direction === 'outbound' ? evidence : [],
  }
}
