/**
 * Job-search operator (#192) — deterministic hard-blocker policy gate.
 *
 * This is the enforcement point the issue calls out explicitly: "a high
 * technical fit must NEVER override a hard legal/work-authorization
 * incompatibility... This must be enforced as a deterministic policy gate
 * in code, not merely prompted — scoring must not be able to route around
 * it." scoring.ts calls evaluatePolicyGate() FIRST and a `blocked` outcome
 * forces REJECTED regardless of the numeric score computed afterward —
 * there is no code path that lets a score override this function's result.
 *
 * Language detection here is intentionally conservative and keyword-based
 * (not an LLM call): a deterministic gate that can be unit-tested exactly
 * is worth more here than a fuzzier classifier that might occasionally be
 * talked out of a hard block. Ambiguous cases fall through to
 * `needs_human`, never to `clear`.
 */
import { PROHIBITED_APPLY_DOMAINS, type HardBlockReason, type PolicyGateResult, type WorkAuthSignals } from './types'

const OPT_EXCLUDED_PATTERNS = [
  /\bno\s+opt\b/i,
  /\bno\s+cpt\b/i,
  // "no CPT/OPT", "no OPT/CPT", "no C2C, no OPT" — "no" doesn't sit
  // immediately next to "opt" once it's paired with CPT, so this needs its
  // own pattern distinct from \bno\s+opt\b above.
  /\bno\s+(?:cpt\s*\/?\s*opt|opt\s*\/?\s*cpt)\b/i,
  /\bopt\s*\/?\s*cpt\s+not\s+(?:accepted|eligible|considered)\b/i,
  /\bopt\s+candidates?\s+(?:are\s+)?not\s+(?:accepted|eligible|considered)\b/i,
  /\bnot\s+eligible\s+for\s+opt\b/i,
  /\bcpt\s*\/?\s*opt\s+not\s+accepted\b/i,
  /\bwe\s+(?:do\s+not|don'?t)\s+(?:sponsor|offer\s+sponsorship)\b/i,
  /\bunable\s+to\s+(?:sponsor|provide\s+sponsorship)\b/i,
  /\bno\s+sponsorship\s+(?:available|provided|offered)\b/i,
  /\bmust\s+not\s+require\s+(?:visa\s+)?sponsorship\b/i,
  /\bwill\s+not\s+sponsor\b/i,
  // Extremely common euphemism: "must be authorized to work ... without
  // ... sponsorship [now or in the future]". Bounded distance so it still
  // requires both phrases to appear close together, not just anywhere in
  // a long posting.
  /\bauthorized\s+to\s+work\b(?:(?!\.).){0,80}?\bwithout\b(?:(?!\.).){0,40}?\bsponsorship\b/i,
  /\bwithout\s+(?:the\s+need\s+for\s+)?(?:employer[- ])?sponsorship\b/i,
]

const CITIZENSHIP_REQUIRED_PATTERNS = [
  /\bmust\s+be\s+an?\s*(?:u\.?s\.?\s+)?(?:citizen|permanent\s+resident)\b/i,
  /\bu\.?s\.?\s+citizenship\s+(?:is\s+)?required\b/i,
  /\bcitizens?\s+only\b/i,
  /\bpermanent\s+residents?\s+only\b/i,
  /\bgreen\s+card\s+holders?\s+only\b/i,
  /\bcitizen\s+or\s+(?:a\s+)?permanent\s+resident\b/i,
  // "U.S. Person" is an ITAR/EAR term of art that functionally excludes
  // OPT/visa holders even when the posting doesn't spell out "as defined
  // by ITAR" — treat the bare term as a hard block, not just its most
  // formally-worded variant.
  /\bu\.?s\.?\s+persons?\b/i,
]

const CLEARANCE_REQUIRED_PATTERNS = [
  /\bactive\s+(?:top\s+secret|secret|ts\/sci)\s+clearance\s+required\b/i,
  /\bmust\s+(?:hold|possess)\s+an?\s+active\s+(?:secret|top\s+secret|ts\/sci)\s+clearance\b/i,
  /\bsecurity\s+clearance\s+required\b/i,
  // Same requirement, no clearance-level word specified.
  /\bactive\s+clearance\s+required\b/i,
  /\bmust\s+(?:hold|possess)\s+an?\s+active\s+clearance\b/i,
  /\bclearance\s+required\b/i,
]

// Weaker clearance-adjacent language: not an unambiguous current-clearance
// requirement, but strongly correlated with citizenship-only eligibility
// in practice. Keyword matching can't safely resolve this either way, so
// it always routes to needs_human, never to a confident block or clear.
const AMBIGUOUS_CLEARANCE_PATTERNS = [
  /\bability\s+to\s+obtain\b(?:(?!\.).){0,40}?\bclearance\b/i,
  /\beligible\s+for\b(?:(?!\.).){0,40}?\bclearance\b/i,
  /\bable\s+to\s+obtain\s+and\s+maintain\b(?:(?!\.).){0,40}?\bclearance\b/i,
]

const AMBIGUOUS_SPONSORSHIP_PATTERNS = [
  /\bsponsorship\b/i,
  /\bwork\s+authorization\b/i,
  /\bvisa\s+status\b/i,
  /\beligib(?:le|ility)\s+to\s+work\b/i,
  // Bare-topic fallback: any mention of these terms that the hard-block
  // patterns above didn't already resolve is treated as ambiguous rather
  // than silently passing through as "clear". Deliberately broad — a
  // false "needs_human" (extra founder review) is the safe failure mode;
  // a false "clear" is not.
  // Excludes the common "opt-in"/"opt out"/"opt-out" benefits-and-surveys
  // usage ("401k opt-in", "opt out of texts") so this doesn't flood the
  // review queue with unrelated postings — "OPT" as the immigration term
  // is essentially never followed by "in"/"out".
  /\bopt\b(?!-?\s*(?:in|out)\b)/i,
  /\bcpt\b/i,
  /\bvisa\b/i,
  /\bgreen\s+card\b/i,
  /\bpermanent\s+resident\b/i,
  /\bcitizenship\b/i,
  /\bclearance\b/i,
  /\bu\.?s\.?\s+person\b/i,
]

function matchesAny(text: string, patterns: RegExp[]): string[] {
  const hits: string[] = []
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) hits.push(match[0])
  }
  return hits
}

/**
 * Deterministic keyword scan over a posting's description + requirements.
 * Never returns a false "clear" for text it hasn't actually examined —
 * callers must pass the full text, not a truncated excerpt.
 *
 * This is naive keyword matching, not a legal/immigration determination.
 * It cannot and does not claim certainty about work-authorization law; it
 * only distinguishes "explicit disqualifying language found" (blocked)
 * from "eligibility-adjacent language found but not clearly resolvable"
 * (needs_human) from "no eligibility-adjacent language found at all"
 * (clear). The bias throughout is toward needs_human over clear whenever
 * the text is ambiguous.
 */
export function detectWorkAuthSignals(text: string): WorkAuthSignals {
  const optHits = matchesAny(text, OPT_EXCLUDED_PATTERNS)
  const citizenshipHits = matchesAny(text, CITIZENSHIP_REQUIRED_PATTERNS)
  const clearanceHits = matchesAny(text, CLEARANCE_REQUIRED_PATTERNS)
  const ambiguousClearanceHits = matchesAny(text, AMBIGUOUS_CLEARANCE_PATTERNS)
  const ambiguousHits = matchesAny(text, AMBIGUOUS_SPONSORSHIP_PATTERNS)

  const hardBlockFound = optHits.length > 0 || citizenshipHits.length > 0 || clearanceHits.length > 0

  return {
    optExcluded: optHits.length > 0,
    citizenshipRequired: citizenshipHits.length > 0,
    clearanceRequired: clearanceHits.length > 0,
    // Ambiguous if any eligibility-adjacent language is present AND none
    // of the hard-block patterns already resolved it explicitly. This is
    // the fallback the whole gate leans on for keyword-list gaps: it is
    // deliberately broader than just "sponsorship" wording (see the
    // bare-topic patterns above) so an unrecognized phrasing degrades to
    // "needs_human" instead of silently reporting "clear".
    ambiguousEligibilityLanguage: !hardBlockFound && (ambiguousHits.length > 0 || ambiguousClearanceHits.length > 0),
    evidence: [...optHits, ...citizenshipHits, ...clearanceHits, ...ambiguousClearanceHits, ...ambiguousHits],
  }
}

export type PolicyGateInput = {
  signals: WorkAuthSignals
  minYearsExperienceRequired: number | null
  /** Founder's own years of professional experience, from the verified profile. Null = unknown, never assume 0 to avoid false hard-blocks. */
  founderYearsExperience: number | null
  /** Verified, founder-supplied answer that resolves sponsorship ambiguity, if one exists (e.g. "OPT/EAD confirmed acceptable at this employer" from a prior recruiter reply). Never inferred. */
  verifiedSponsorshipOverride: boolean
  /**
   * False when minYearsExperienceRequired was explicitly qualified as
   * "preferred"/"nice to have"/"a plus" rather than stated as a strict
   * minimum (see parseYearsRequired in ingest.ts) — such postings should
   * not be hard-blocked purely on an experience gap; a large gap still
   * lowers fit naturally via scoring.ts's experienceGapPenalty, it just
   * shouldn't be an outright reject the way an actual "X years required"
   * cutoff is. Optional and defaults to true (the prior, more
   * conservative behavior) so existing callers that don't distinguish
   * required-vs-preferred keep their current behavior unchanged.
   */
  experienceRequirementIsHard?: boolean
}

const JUNIOR_TARGET_MAX_YEARS_REQUIRED = 5

export function evaluatePolicyGate(input: PolicyGateInput): PolicyGateResult {
  const { signals } = input

  if (signals.optExcluded) {
    return {
      outcome: 'blocked',
      reason: 'opt_excluded',
      detail: `Posting explicitly excludes OPT/sponsorship candidates: ${signals.evidence.join('; ') || 'pattern match'}`,
    }
  }

  if (signals.citizenshipRequired) {
    return {
      outcome: 'blocked',
      reason: 'citizenship_required',
      detail: 'Posting requires U.S. citizenship; founder profile does not satisfy this (OPT/EAD, not a citizen requirement).',
    }
  }

  if (signals.clearanceRequired) {
    return {
      outcome: 'blocked',
      reason: 'clearance_required',
      detail: 'Posting requires an active security clearance; no verified clearance on the founder profile.',
    }
  }

  if (
    input.minYearsExperienceRequired !== null &&
    input.minYearsExperienceRequired > JUNIOR_TARGET_MAX_YEARS_REQUIRED &&
    (input.experienceRequirementIsHard ?? true)
  ) {
    return {
      outcome: 'blocked',
      reason: 'experience_gap_too_large',
      detail: `Posting requires ${input.minYearsExperienceRequired}+ years; exceeds junior/early-career target threshold of ${JUNIOR_TARGET_MAX_YEARS_REQUIRED}.`,
    }
  }

  if (signals.ambiguousEligibilityLanguage && !input.verifiedSponsorshipOverride) {
    return {
      outcome: 'needs_human',
      reason: 'ambiguous_work_authorization',
      detail: `Posting mentions work authorization/sponsorship without a clear resolution: ${signals.evidence.join('; ') || 'ambiguous language'}. No verified profile answer resolves this.`,
    }
  }

  return { outcome: 'clear' }
}

export function hardBlockReasonToRejection(result: Extract<PolicyGateResult, { outcome: 'blocked' }>): string {
  const labels: Record<HardBlockReason, string> = {
    opt_excluded: 'OPT/sponsorship explicitly excluded',
    citizenship_required: 'U.S. citizenship required, not satisfied',
    clearance_required: 'Active security clearance required, not satisfied',
    experience_gap_too_large: 'Required experience exceeds junior/early-career target',
  }
  return labels[result.reason]
}

/**
 * Discovery from these domains is fine; automated SUBMISSION never is.
 * Checked against the apply URL's hostname (and its parent domains), never
 * against free text, so a job description merely mentioning "LinkedIn"
 * can't accidentally trip this.
 */
export function isProhibitedApplyDestination(applyUrl: string): boolean {
  let hostname: string
  try {
    hostname = new URL(applyUrl).hostname.toLowerCase()
  } catch {
    // Unparseable URL: treat as prohibited/unsafe rather than assuming safe.
    return true
  }
  return PROHIBITED_APPLY_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  )
}
