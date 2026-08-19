/**
 * Pure guard that catches invented payment-terms figures in a draft reply
 * before it ships. Sibling of caye-identity-guard.ts — same reasoning: the
 * system prompt already forbids this, and the prompt alone was not enough.
 *
 * WHY THIS EXISTS (2026-08-07)
 * Karin Roberts thread, 2026-08-06. Caye told a live customer "a 25% deposit
 * ($99.50) is required at booking". Minutes later, drafting for the same
 * customer in the back office, she said "we require a 50% deposit ($199.00)".
 * Neither number existed anywhere in the workspace — no business_facts row,
 * no service_pricing_tiers column, nothing. Both were invented, they
 * contradicted each other, and the wrong one was already in the customer's
 * inbox before anyone noticed.
 *
 * A deposit figure is irreversible in the way that matters: once a customer
 * has "25%" in writing, that's the number they'll hold the business to. So
 * this is enforced in code rather than left to prompt text — the same
 * conclusion the outreach work reached after an LLM ignored its own ban list.
 *
 * SCOPE — deliberately narrow, to stay false-positive-free:
 * only sentences that actually assert payment terms (deposit / prepayment /
 * processing-or-cancellation fee) are inspected, and only the numbers in
 * them are checked. Ordinary price quotes are NOT touched: those have their
 * own enforcement path (lookup_price returns the verbatim labels).
 *
 * NOT A SEMANTIC GROUNDING CHECK. Whether a *prose* policy claim ("we'd
 * offer a full refund if the ship can't make port") is supported can't be
 * decided by regex — a workspace whose facts mention refunds for rain would
 * pass a naive keyword test. That case is covered by the high_stakes_claim
 * flag on send_reply, which holds the draft for the owner. This module only
 * answers the question it can answer exactly: is this NUMBER attested?
 */

/** A number written as a percentage — "25%", "25 percent", "25.5%". */
const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi

/** A number written as money — "$99.50", "$1,200", "$199". */
const AMOUNT_PATTERN = /\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)/g

/**
 * Sentences worth inspecting: ones asserting what the customer must pay to
 * hold a booking, or a fee deducted from their money. "Deposit" alone is the
 * dominant real-world phrasing; the rest catch the near-synonyms.
 */
const PAYMENT_TERMS_PATTERN =
  /\b(deposits?|down\s?payment|pre[- ]?payment|paid\s+upfront|due\s+upfront|(?:administrative|admin|processing|cancellation|booking)\s+fee|fee\s+will\s+be\s+deducted)\b/i

/** Collapse "199.00" / "$1,200" / "25" to one canonical numeric string so
 *  "$199.00" in a draft matches "$199" in a stored fact. */
function canonical(raw: string): string {
  const n = Number.parseFloat(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? String(n) : raw.trim()
}

function collect(text: string, pattern: RegExp): string[] {
  const out: string[] = []
  for (const m of text.matchAll(pattern)) out.push(canonical(m[1]))
  return out
}

/** Split into sentences. Newlines count as breaks — drafts are paragraphed,
 *  and a bare line like "Standard: $220 total" has no terminal punctuation. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface AttestedFigures {
  percentages: Set<string>
  amounts: Set<string>
}

/**
 * The figures the grounding text actually attests, kept in separate sets by
 * unit. Sharing one set is unsound: the stored "$30–$50 administrative
 * processing fee" would otherwise attest "50" and silently ground an invented
 * "50% deposit" — which is exactly the figure this module exists to catch.
 */
export function attestedFigures(groundingText: string): AttestedFigures {
  return {
    percentages: new Set(collect(groundingText, PERCENT_PATTERN)),
    amounts: new Set(collect(groundingText, AMOUNT_PATTERN)),
  }
}

/**
 * Returns a short reason string when the draft states a payment-terms figure
 * that the grounding text doesn't attest, otherwise null.
 *
 * `groundingText` should be everything the workspace actually knows —
 * concatenated business_facts, which are all loaded into the reply prompt
 * anyway, so a figure absent from them was not read from anywhere.
 *
 * When a sentence carries a percentage, only the percentage is checked: the
 * dollar figure beside it is usually that percentage applied to an
 * already-verified price ("50% deposit ($199.00)"), and demanding the derived
 * amount also be stored would block correct arithmetic. Ground the rate and
 * the amount follows.
 */
export function detectUnverifiedPaymentFigure(
  content: string,
  groundingText: string
): string | null {
  const attested = attestedFigures(groundingText)

  for (const sentence of sentences(content)) {
    if (!PAYMENT_TERMS_PATTERN.test(sentence)) continue

    const percentages = collect(sentence, PERCENT_PATTERN)
    const ungroundedPct = percentages.filter((p) => !attested.percentages.has(p))
    if (ungroundedPct.length > 0) {
      return `states an unverified deposit rate (${ungroundedPct
        .map((p) => `${p}%`)
        .join(', ')}) with no matching business fact`
    }
    // A rate in the sentence explains any amount beside it; without one, the
    // amount is the claim and has to stand on its own.
    if (percentages.length > 0) continue

    const amounts = collect(sentence, AMOUNT_PATTERN)
    const ungroundedAmt = amounts.filter((a) => !attested.amounts.has(a))
    if (ungroundedAmt.length > 0) {
      return `states an unverified payment-terms amount ($${ungroundedAmt.join(
        ', $'
      )}) with no matching business fact`
    }
  }

  return null
}

/**
 * WHY THIS EXISTS (2026-08-16, Phase "final pre-canary closure")
 * Real Bimini incident: Caye told a customer cash was not accepted; Mrs.
 * Max had to correct the customer herself afterward. The figure guard
 * above only catches invented NUMBERS (a deposit rate, a fee amount) — a
 * payment-METHOD assertion ("we don't take cash", "card only", "we accept
 * Venmo") carries no number at all and passed straight through it. Same
 * reasoning as the module header: the prompt already says not to invent
 * policy, the prompt alone was not enough, so this is enforced in code.
 *
 * Payment methods recognised. Deliberately a fixed, small list rather than
 * an open-ended NLP task — matches the figure guard's own tradeoff (stay
 * narrow, stay false-positive-free) over trying to parse arbitrary policy
 * prose.
 */
const PAYMENT_METHOD_PATTERN =
  /\b(cash|credit\s*card|debit\s*card|\bcard\b|check|cheque|venmo|zelle|paypal|cash\s*app|apple\s*pay|google\s*pay|wire\s*transfer|cryptocurrency|crypto)\b/gi

/** A sentence asserting whether a payment method is or isn't accepted/taken/allowed. */
const PAYMENT_METHOD_ASSERTION_PATTERN =
  /\b(accept|accepted|accepts|accepting|take|takes|taking|taken|allow|allowed|only|no\s+cash|cash\s*[- ]?only)\b/i

/**
 * Returns a short reason string when the draft asserts whether a specific
 * payment method is accepted and that method is never mentioned anywhere
 * in the grounding text (business facts) — meaning the assertion, whatever
 * its polarity, was invented rather than read from anything. Symmetric
 * with `attestedFigures`: a method absent from the grounding text entirely
 * is ungrounded regardless of whether the draft says yes or no about it.
 */
export function detectUnverifiedPaymentMethodClaim(
  content: string,
  groundingText: string
): string | null {
  const groundedMethods = new Set(
    Array.from(groundingText.matchAll(PAYMENT_METHOD_PATTERN)).map((m) => m[0].toLowerCase().replace(/\s+/g, ' '))
  )

  for (const sentence of sentences(content)) {
    if (!PAYMENT_METHOD_ASSERTION_PATTERN.test(sentence)) continue
    const methodsInSentence = Array.from(sentence.matchAll(PAYMENT_METHOD_PATTERN)).map((m) =>
      m[0].toLowerCase().replace(/\s+/g, ' ')
    )
    const unverified = methodsInSentence.filter((m) => !groundedMethods.has(m))
    if (unverified.length > 0) {
      return `states a payment method policy (${Array.from(new Set(unverified)).join(', ')}) with no matching business fact`
    }
  }

  return null
}

/**
 * WHY THIS EXISTS (2026-08-19, CAY-92)
 * Bimini Island Tours, Jonathan thread: asked about snorkeling/Snuba, Caye
 * told him the business could coordinate it through a trusted partner —
 * before any owner had ever said that was true. No business fact, no owner
 * instruction anywhere: pure invented commitment, and unlike a wrong number
 * it doesn't just misinform, it obligates the business to a partner
 * arrangement the customer will expect followed through. Same incident
 * class as a separate thread where Caye asserted a cancellation/date
 * situation had occurred when the underlying date reasoning was simply
 * wrong.
 *
 * Same shape and tradeoff as the two guards above: narrow, sentence-scoped,
 * requires an affirmative committing construction (a hedge — "let me check
 * with our partner" — asserts nothing and must not trip this), and
 * "grounded" means the same claim shape already appears in a hedge-free
 * sentence of what the business actually told Caye. On the front-desk send
 * path that grounding text includes the owner's own words sent into THIS
 * thread (send-customer-reply.ts's factsGrounding — the same mechanism the
 * payment guards already use for the Juli-class in-thread correction), so
 * an owner saying "we can coordinate through one of our trusted partners"
 * authorises exactly that commitment for that thread — CAY-92 fixture 2.
 *
 * Two categories, both with real incident evidence and both the kind of
 * claim a customer holds a business to indefinitely:
 *   - coordinating/arranging something through a THIRD PARTY (partner,
 *     vendor, outside operator — the Jonathan snorkeling/Snuba incident)
 *   - a REFUND/CANCELLATION outcome (money promised back, or a booking
 *     promised undone)
 *
 * NOT a semantic/polarity check, same limitation as the payment-method
 * guard above: a business fact merely mentioning "refund" (even to deny
 * one) grounds the concept. Getting the polarity right is a harder,
 * separate problem than "was this invented from nothing" — this module
 * only answers the question it can answer exactly.
 */
const COMMITMENT_HEDGE_PATTERN =
  /\b(?:let me|i'?ll|i will|i can|we(?:'ll| will)?\s+(?:check|see|ask|reach out|find out|look into)|checking|check with|confirm|verify|whether|if (?:it'?s|we|they)|see if|once (?:i|we)|get back|find out|not sure|might be|should be|may be|would need to|reach out to)\b/i

const THIRD_PARTY_COMMIT_VERB_PATTERN =
  /\b(?:coordinate[sd]?|coordinating|arrange[sd]?|arranging|set(?:s|ting)?\s+up|book(?:ed|s|ing)?|organiz(?:e[sd]?|ing)|handle[sd]?|handling|take\s+care\s+of|took\s+care\s+of|line[sd]?\s+up|lining\s+up)\b/i

const THIRD_PARTY_NOUN_PATTERN =
  /\b(?:(?:trusted\s+)?partners?|vendors?|affiliates?|third[- ]part(?:y|ies)|outside\s+(?:company|companies|operator|vendor)|another\s+(?:company|operator|provider)|local\s+operators?|tour\s+operators?|dive\s+(?:shop|operator|company)|charter\s+(?:company|operator|boat)|snuba|snorkel(?:l?ing)?\s+(?:company|operator|outfit|excursion))\b/i

const REFUND_CANCELLATION_COMMIT_PATTERN =
  /\b(?:refund(?:ed|ing|s)?|reimburse(?:d|ment|s)?|money\s+back|(?:full|partial)\s+refund|cancel(?:led|ling|s)?\s+(?:your|the)\s+(?:booking|reservation)\s+and\s+refund|refund\s+(?:your|the)\s+(?:deposit|payment|booking))\b/i

/** True when `groundingText` contains the same claim shape in a hedge-free sentence of its own. */
function groundedBySentence(groundingText: string, requiredPatterns: readonly RegExp[]): boolean {
  return sentences(groundingText).some(
    (s) => !COMMITMENT_HEDGE_PATTERN.test(s) && requiredPatterns.every((p) => p.test(s))
  )
}

/**
 * Returns a short reason string when the draft affirmatively commits the
 * business to coordinating/arranging something through a third party
 * (partner, vendor, outside operator) that no business fact or in-thread
 * owner instruction backs, otherwise null. See module doc above.
 */
export function detectUnsupportedThirdPartyCommitment(
  content: string,
  groundingText: string
): string | null {
  for (const sentence of sentences(content)) {
    if (COMMITMENT_HEDGE_PATTERN.test(sentence)) continue
    if (!THIRD_PARTY_COMMIT_VERB_PATTERN.test(sentence)) continue
    if (!THIRD_PARTY_NOUN_PATTERN.test(sentence)) continue
    if (groundedBySentence(groundingText, [THIRD_PARTY_COMMIT_VERB_PATTERN, THIRD_PARTY_NOUN_PATTERN])) continue
    return `states a third-party/partner commitment ("${sentence}") with no matching business fact or owner instruction`
  }
  return null
}

/**
 * Returns a short reason string when the draft affirmatively promises a
 * refund/cancellation outcome that no business fact or in-thread owner
 * instruction backs, otherwise null. See module doc above.
 */
export function detectUnsupportedRefundCommitment(
  content: string,
  groundingText: string
): string | null {
  for (const sentence of sentences(content)) {
    if (COMMITMENT_HEDGE_PATTERN.test(sentence)) continue
    if (!REFUND_CANCELLATION_COMMIT_PATTERN.test(sentence)) continue
    if (groundedBySentence(groundingText, [REFUND_CANCELLATION_COMMIT_PATTERN])) continue
    return `states a refund/cancellation commitment ("${sentence}") with no matching business fact or owner instruction`
  }
  return null
}
