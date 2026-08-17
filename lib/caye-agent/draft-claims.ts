/**
 * draft-claims.ts
 *
 * Pure text analysis: what does this drafted reply actually ASSERT?
 *
 * The evidence gate needs to know whether a draft commits the business to a
 * price or to a date before it can decide whether that commitment is backed
 * by anything. Nothing here talks to a database or a model — it is regex over
 * a string, deliberately, so it is fast, testable, and cannot itself fail.
 *
 * Tuned to be quiet. A false positive holds a reply that should have shipped,
 * which costs a customer a wait; the brief is explicit that Caye must not be
 * made less capable to feel safer. So every detector below requires
 * affirmative, committing language and backs off from hedged or interrogative
 * phrasing.
 */

/** "$99.50", "$1,200", "$199" → canonical numeric strings. */
const AMOUNT_PATTERN = /\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)/g

function canonical(raw: string): string {
  const n = Number.parseFloat(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? String(n) : raw.trim()
}

/** Every dollar figure the draft states, canonicalised for comparison. */
export function extractDollarAmounts(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(AMOUNT_PATTERN)) out.push(canonical(m[1]))
  return Array.from(new Set(out))
}

/**
 * Is every figure in the draft present in the material we actually retrieved?
 *
 * `corpus` is the concatenation of what deterministic code put in front of the
 * model this turn — the services list, pricing tiers, business facts, tool
 * results. A number that appears there was read from the database. A number
 * that appears nowhere in it was produced by the model.
 */
export function amountsAttestedBy(amounts: string[], corpus: string): boolean {
  if (amounts.length === 0) return true
  const corpusAmounts = new Set(extractDollarAmounts(corpus))
  // Bare numerals too: the services list may render "150" without a $ sign.
  for (const m of corpus.matchAll(/\b(\d+(?:,\d{3})*(?:\.\d+)?)\b/g)) {
    corpusAmounts.add(canonical(m[1]))
  }
  return amounts.every((a) => corpusAmounts.has(a))
}

/** Hedges that turn an assertion into a question or a promise to check. */
const HEDGE_PATTERN =
  /\b(?:let me|i'?ll|i will|i can|checking|check|confirm|verify|whether|if it'?s|see if|once i|get back|find out|not sure|might be|should be|may be)\b/i

/**
 * Affirmative availability claims — "that date works", "we have space".
 *
 * Requires a committing construction. "Let me check if the 20th is available"
 * asserts nothing and must not trip this.
 */
const AVAILABILITY_PATTERNS: readonly RegExp[] = [
  /\b(?:we|there)\s*(?:'ve|'re|s|is|are|do)?\s*(?:still\s+)?(?:have|got)\s+(?:availability|space|room|openings?|spots?|a spot)\b/i,
  /\b(?:that|this|the)\s+(?:date|day|time|slot|morning|afternoon)\s+(?:is\s+)?(?:available|open|free|works|good)\b/i,
  /\b(?:is|are)\s+available\b/i,
  /\bwe\s+can\s+(?:fit|accommodate|take)\s+(?:you|your)\b/i,
  /\bwe\s+(?:have|do have)\s+(?:that|the)\s+(?:date|day|slot|time)\b/i,
  /\byes,?\s+(?:we\s+can|that\s+works|that'?s\s+available)\b/i,
]

/** Split on sentence boundaries so a hedge in one clause can't excuse a claim in another. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?\n])\s+/).filter((s) => s.trim().length > 0)
}

/**
 * Does this draft tell the customer a specific slot is open?
 *
 * Sentence-scoped: a draft may legitimately say "the 20th is available, but
 * let me confirm the boat" — the first clause is still a commitment. Only a
 * hedge in the SAME sentence as the claim neutralises it.
 */
export function assertsAvailability(text: string): boolean {
  for (const sentence of sentences(text)) {
    if (HEDGE_PATTERN.test(sentence)) continue
    if (AVAILABILITY_PATTERNS.some((p) => p.test(sentence))) return true
  }
  return false
}

/**
 * The same sentence-scoped logic as `assertsAvailability`, but returns the
 * draft with the unverified sentence(s) removed instead of a boolean.
 *
 * Exists because the evidence gate (evidence.ts) used to hold the ENTIRE
 * drafted reply the moment any one sentence tripped `assertsAvailability` —
 * discarding a definition, other tour options, or an already-grounded price
 * that happened to share a message with one unverified availability claim
 * (the Pam Ott incident, 2026-08-17: "what's a shared tour, how many people,
 * any other options" got held in full over one unverified sentence about
 * group size). Everything else in the draft is real; only the claim itself
 * needs to wait on the owner.
 */
export function withoutAvailabilityClaims(text: string): string {
  const kept = sentences(text).filter((sentence) => {
    if (HEDGE_PATTERN.test(sentence)) return true
    return !AVAILABILITY_PATTERNS.some((p) => p.test(sentence))
  })
  return kept.join(' ').trim()
}
