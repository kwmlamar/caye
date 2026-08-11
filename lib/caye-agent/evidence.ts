import 'server-only'

/**
 * evidence.ts
 *
 * Confidence derived from what was actually established, not from what the
 * model says it feels.
 *
 * WHY (2026-08-11)
 * `send_reply` took a `confidence: 'high' | 'medium' | 'low'` argument that
 * the model wrote about its own reply, and that value decided whether the
 * message shipped, shipped-and-escalated, or was held. Two problems, both
 * real rather than theoretical:
 *
 *   1. It is unfalsifiable. A model that has invented a price will rate
 *      itself 'high' with exactly the same conviction as one reading it out
 *      of the services table.
 *   2. It leaked. "Caye self-rated confidence=medium on her reply" went to
 *      Mrs. Max verbatim.
 *
 * What replaces it: a set of facts that either were or were not established
 * this turn — the service was matched, the price came from the database, the
 * availability rules were evaluated — and a policy saying which actions each
 * set of facts is sufficient to authorise.
 *
 * The model's self-rating is retained as a DOWNGRADE-ONLY signal. It can make
 * Caye more careful; it can never make her bolder. Evidence authorises.
 */

/**
 * A fact that was established by deterministic code this turn — a database
 * read, a rule evaluation, a match above threshold. Never something the
 * model asserted.
 */
export type EvidenceFact =
  /** We know who this is (contact record or verified email/phone). */
  | 'customer_identified'
  /** The requested service matched a real row at high confidence. */
  | 'service_identified'
  /** A concrete date was parsed from the customer's message. */
  | 'date_identified'
  /** A concrete party size was parsed. */
  | 'party_size_identified'
  /** Price came from the services/pricing tables, not from the model. */
  | 'price_from_database'
  /** Availability rules were actually evaluated for this date/service. */
  | 'availability_verified'
  /** Payment state was read from the booking/payment record. */
  | 'payment_verified'
  /** A booking row exists for this exchange. */
  | 'booking_exists'

export type EvidenceSet = ReadonlySet<EvidenceFact>

/**
 * Actions the policy gates, ordered by what it costs to get them wrong.
 *
 * The brief's ladder: an informational reply needs almost nothing, a quote
 * needs the numbers to be real, a booking needs the whole picture, and money
 * needs the strongest guarantees available.
 */
export type GatedAction =
  | 'informational_reply'
  | 'state_availability'
  | 'send_quote'
  | 'create_booking'
  | 'payment_action'

/**
 * Evidence each action requires. Everything absent from a requirement list is
 * genuinely not needed — `informational_reply` requires nothing because
 * answering "what time do you open?" should never be gated.
 */
export const ACTION_REQUIREMENTS: Record<GatedAction, readonly EvidenceFact[]> = {
  informational_reply: [],
  // Saying "yes, that day works" without having evaluated the rules is
  // inventing availability — the specific failure mode called out in the
  // brief's item 7.
  state_availability: ['service_identified', 'date_identified', 'availability_verified'],
  // A quote is a number the customer will hold us to. It comes out of the
  // pricing tables or it does not go out.
  send_quote: ['service_identified', 'price_from_database'],
  create_booking: [
    'customer_identified',
    'service_identified',
    'date_identified',
    'party_size_identified',
    'availability_verified',
  ],
  payment_action: ['customer_identified', 'booking_exists', 'payment_verified'],
}

export interface PolicyVerdict {
  permitted: boolean
  missing: EvidenceFact[]
}

export function evaluateAction(action: GatedAction, evidence: EvidenceSet): PolicyVerdict {
  const missing = ACTION_REQUIREMENTS[action].filter((f) => !evidence.has(f))
  return { permitted: missing.length === 0, missing }
}

/**
 * What the front desk should do with a drafted reply.
 *
 * - `send`            — ship it, nothing outstanding.
 * - `send_and_flag`   — ship it, but ping the owner to check behind us. The
 *                       customer is not blocked, so holding would leave them
 *                       waiting on a person for no reason.
 * - `hold`            — do not ship. The draft goes to the owner instead.
 */
export type Disposition = 'send' | 'send_and_flag' | 'hold'

export interface DispositionInput {
  evidence: EvidenceSet
  /**
   * The model's own rating. Advisory. May downgrade send → send_and_flag;
   * may never upgrade hold → send.
   */
  modelConfidence?: 'high' | 'medium' | 'low' | null
  /** The model flagged a safety/accessibility-adjacent assertion. */
  highStakesClaim?: boolean
  /** The draft contains a price/figure the customer could hold us to. */
  quotesPrice?: boolean
  /** The draft asserts something about availability. */
  claimsAvailability?: boolean
  /** The model explicitly asked for owner follow-up. */
  requestsOwnerFollowup?: boolean
}

export interface DispositionResult {
  disposition: Disposition
  /**
   * Machine-readable reasons, for logs and tests. NEVER rendered to an
   * operator or customer — see lib/operator-text-guard.ts. The human-facing
   * sentence is composed separately by the caller.
   */
  reasons: string[]
  /** Evidence the gated action needed and did not have. */
  missing: EvidenceFact[]
}

/**
 * Decide, from evidence first and the model's opinion second.
 *
 * Order matters: every hold below is triggered by a missing FACT, and the
 * model's self-rating is consulted only after the evidence checks have all
 * passed. That ordering is the whole point — it is what stops a confident
 * model from talking its way past a check.
 */
export function decideDisposition(input: DispositionInput): DispositionResult {
  const reasons: string[] = []
  const missing: EvidenceFact[] = []

  // A safety or accessibility claim is held unless we can point at the record
  // it came from. Unchanged in spirit from the previous rule; the difference
  // is that it now turns on evidence rather than on the model agreeing it was
  // unsure.
  if (input.highStakesClaim && !input.evidence.has('customer_identified')) {
    reasons.push('high_stakes_claim_without_verified_context')
  }

  if (input.quotesPrice) {
    const verdict = evaluateAction('send_quote', input.evidence)
    if (!verdict.permitted) {
      reasons.push('quote_without_database_price')
      missing.push(...verdict.missing)
    }
  }

  if (input.claimsAvailability) {
    const verdict = evaluateAction('state_availability', input.evidence)
    if (!verdict.permitted) {
      reasons.push('availability_claim_unverified')
      missing.push(...verdict.missing)
    }
  }

  if (reasons.length > 0) {
    return { disposition: 'hold', reasons, missing: dedupe(missing) }
  }

  // Evidence is satisfied. Only now may the model's opinion be heard, and
  // only in the cautious direction.
  if (input.modelConfidence && input.modelConfidence !== 'high') {
    return {
      disposition: 'send_and_flag',
      reasons: ['model_reported_uncertainty'],
      missing: [],
    }
  }
  if (input.requestsOwnerFollowup) {
    return { disposition: 'send_and_flag', reasons: ['owner_followup_requested'], missing: [] }
  }

  return { disposition: 'send', reasons: [], missing: [] }
}

function dedupe(facts: EvidenceFact[]): EvidenceFact[] {
  return Array.from(new Set(facts))
}

/**
 * Plain-English note for the owner. Built from the same verdict the gate
 * used, so what she reads and what actually happened cannot drift apart —
 * and containing no internal vocabulary, per item 12. No "evidence", no
 * "policy", no "disposition", no fact identifiers.
 */
export function ownerNoteFor(result: DispositionResult, ownerNote?: string | null): string {
  const detail = ownerNote?.trim() ? `\n\nWhat I was unsure about: ${ownerNote.trim()}` : ''

  if (result.disposition === 'hold') {
    if (result.reasons.includes('quote_without_database_price')) {
      return (
        `I drafted a reply with a price in it that I couldn't confirm against your ` +
        `rates, so I held it rather than quote her something wrong. Have a look and ` +
        `send it if it's right.` + detail
      )
    }
    if (result.reasons.includes('availability_claim_unverified')) {
      return (
        `I drafted a reply saying that slot works, but I couldn't confirm it against ` +
        `your schedule, so I held it instead of promising her something. Have a look.` +
        detail
      )
    }
    return (
      `I drafted a reply but wasn't confident enough to send it on my own. It's ` +
      `waiting for you to check.` + detail
    )
  }

  if (result.reasons.includes('model_reported_uncertainty')) {
    return (
      `I answered her, but I wasn't fully sure of what I said. The reply already went ` +
      `out, so nothing is waiting on you — worth a read in case it needs correcting.` +
      detail
    )
  }

  return (ownerNote?.trim() || 'Owner follow-up requested')
}
