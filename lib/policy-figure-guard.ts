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
