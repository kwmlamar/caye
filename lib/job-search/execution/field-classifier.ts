/**
 * Job-search operator (CAY-194 / #194) — deterministic ATS field
 * classifier.
 *
 * Maps a discovered form field's label to one of our normalized semantic
 * keys via keyword matching only — no LLM. Per the issue's "Form
 * understanding" requirement: "An LLM may assist as a parser, but
 * consequential field resolution must be validated deterministically — LLM
 * output alone may not authorize submission." This module doesn't even
 * offer an LLM path in v1; keyword matching against a small, auditable
 * pattern list is enough for the structured question metadata Greenhouse's
 * Job Board API already returns, and keeps semantic classification 100%
 * testable without a model call.
 *
 * Bias, same as policy-gate.ts: an unmatched or ambiguous label returns
 * `null` (unmapped) rather than a guess. An unmapped field is never
 * auto-filled — see preflight/executor's resolveField, which only fills a
 * field with a non-null semanticKey matched to a verified profile fact.
 */
import type { HighRiskSemanticKey } from './types'

/**
 * Labels whose meaning DEPENDS ON A NEGATION that a single canonical
 * yes/no fact cannot carry.
 *
 * This is the sharpest failure mode in the whole classifier. Consider two
 * real questions:
 *
 *   A. "Will you now or in the future require sponsorship?"
 *   B. "Are you legally authorized to work in the US WITHOUT sponsorship?"
 *
 * Both contain "sponsor". Both were previously classified `sponsorship` and
 * would therefore reuse the SAME stored answer — but the correct answers are
 * exact opposites. Answering B with A's answer is not a near-miss; it is an
 * affirmative false statement to an employer on a legal question.
 *
 * A keyword classifier cannot resolve this, and inverting a boolean by
 * pattern-matching "without"/"not" is exactly the kind of clever inference
 * that must never sit in a consequential path. So: any label matching a
 * negation marker alongside a polarity-sensitive topic is refused outright
 * (classified `null` -> unresolved -> escalated to the founder), rather than
 * mapped to a key whose stored answer would silently invert.
 */
const NEGATION_MARKER = /\bwithout\b|\bnot\b|\bno longer\b|\bnever\b|\bunable\b|\bdo not\b|\bdon'?t\b|\bexcept\b|\bother than\b/i

/** Topics where a stored yes/no answer flips meaning under negation. */
const POLARITY_SENSITIVE = new Set<string>([
  'sponsorship',
  'work_authorization',
  'citizenship',
  'clearance',
  'criminal_history',
  'drivers_license',
  'relocation',
  'willingness_to_travel',
])

const PATTERNS: [HighRiskSemanticKey | 'first_name' | 'last_name' | 'email' | 'phone' | 'resume' | 'cover_letter' | 'linkedin', RegExp][] = [
  // work_authorization is tested BEFORE sponsorship on purpose. "Are you
  // legally authorized to work in the United States?" is a work-authorization
  // question even when it goes on to mention sponsorship; the original order
  // classified every such label as `sponsorship` and would have answered an
  // authorization question from a sponsorship fact.
  ['work_authorization', /work\s+authoriz|authoriz(?:ed|ation)\s+to\s+work|legally\s+(?:able|eligible|authorized)\s+to\s+work|right\s+to\s+work|eligible\s+to\s+work/i],
  ['sponsorship', /sponsor/i],
  ['citizenship', /citizen(?:ship)?/i],
  ['clearance', /security\s+clearance|clearance\s+level/i],
  ['criminal_history', /criminal|convict|felony/i],
  ['disability', /disab(?:led|ility)/i],
  ['veteran_status', /veteran/i],
  // The trailing \b after the group used to swallow every inflected form:
  // "pronouns" and "ethnicity" both failed to match, because \b cannot hold
  // between "pronoun"/"s" or "ethnicit"/"y". ("Race/Ethnicity" only appeared
  // to work because "race" matched first.) Suffixes are explicit now.
  ['demographic', /\b(race|ethnic\w*|gender\w*|sex|pronouns?)\b/i],
  ['relocation', /relocat/i],
  ['compensation', /salary|compensation|desired\s+pay|pay\s+expectation/i],
  ['legal_attestation', /attest|certify|acknowledge.*(?:true|accurate)|legal(?:ly)?\s+bind/i],
  ['willingness_to_travel', /travel/i],
  ['drivers_license', /driver.?s?\s+licen[cs]e/i],
  ['availability_start_date', /start\s+date|available\s+(?:to\s+)?start|availability|(?:when|how\s+soon).{0,30}\bstart\b|earliest\s+start|notice\s+period/i],
  ['background_check_acknowledgment', /background\s+check/i],
  ['arbitration_acknowledgment', /arbitrat/i],
  ['linkedin', /linked\s*in/i],
  ['first_name', /first\s*name/i],
  ['last_name', /last\s*name/i],
  ['email', /e-?mail/i],
  ['phone', /phone/i],
  ['resume', /r[ée]sum[ée]|\bcv\b/i],
  ['cover_letter', /cover\s+letter/i],
]

export function classifyFieldLabel(label: string): string | null {
  for (const [key, pattern] of PATTERNS) {
    if (!pattern.test(label)) continue
    // Refuse rather than risk an inverted answer. See NEGATION_MARKER above.
    if (POLARITY_SENSITIVE.has(key) && NEGATION_MARKER.test(label)) return null
    return key
  }
  return null
}
