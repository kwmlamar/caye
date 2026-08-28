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
  /\bopt\s+candidates?\s+(?:are\s+)?not\s+(?:accepted|eligible|considered)\b/i,
  /\bnot\s+eligible\s+for\s+opt\b/i,
  /\bcpt\s*\/?\s*opt\s+not\s+accepted\b/i,
  /\bwe\s+(?:do\s+not|don'?t)\s+(?:sponsor|offer\s+sponsorship)\b/i,
  /\bunable\s+to\s+(?:sponsor|provide\s+sponsorship)\b/i,
  /\bno\s+sponsorship\s+(?:available|provided|offered)\b/i,
  /\bmust\s+not\s+require\s+(?:visa\s+)?sponsorship\b/i,
]

const CITIZENSHIP_REQUIRED_PATTERNS = [
  /\bmust\s+be\s+a?\s*u\.?s\.?\s+citizen\b/i,
  /\bu\.?s\.?\s+citizenship\s+(?:is\s+)?required\b/i,
  /\bcitizens?\s+only\b/i,
  /\bU\.?S\.?\s+person\s+as\s+defined\s+by\s+ITAR\b/i,
]

const CLEARANCE_REQUIRED_PATTERNS = [
  /\bactive\s+(?:top\s+secret|secret|ts\/sci)\s+clearance\s+required\b/i,
  /\bmust\s+(?:hold|possess)\s+an?\s+active\s+(?:secret|top\s+secret|ts\/sci)\s+clearance\b/i,
  /\bsecurity\s+clearance\s+required\b/i,
]

const AMBIGUOUS_SPONSORSHIP_PATTERNS = [
  /\bsponsorship\b/i,
  /\bwork\s+authorization\b/i,
  /\bvisa\s+status\b/i,
  /\beligib(?:le|ility)\s+to\s+work\b/i,
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
 */
export function detectWorkAuthSignals(text: string): WorkAuthSignals {
  const optHits = matchesAny(text, OPT_EXCLUDED_PATTERNS)
  const citizenshipHits = matchesAny(text, CITIZENSHIP_REQUIRED_PATTERNS)
  const clearanceHits = matchesAny(text, CLEARANCE_REQUIRED_PATTERNS)
  const ambiguousHits = matchesAny(text, AMBIGUOUS_SPONSORSHIP_PATTERNS)

  return {
    optExcluded: optHits.length > 0,
    citizenshipRequired: citizenshipHits.length > 0,
    clearanceRequired: clearanceHits.length > 0,
    // Ambiguous only if sponsorship/work-auth language is present AND none
    // of the hard-block patterns already resolved it explicitly.
    ambiguousSponsorshipLanguage:
      ambiguousHits.length > 0 && optHits.length === 0 && citizenshipHits.length === 0 && clearanceHits.length === 0,
    evidence: [...optHits, ...citizenshipHits, ...clearanceHits, ...ambiguousHits],
  }
}

export type PolicyGateInput = {
  signals: WorkAuthSignals
  minYearsExperienceRequired: number | null
  /** Founder's own years of professional experience, from the verified profile. Null = unknown, never assume 0 to avoid false hard-blocks. */
  founderYearsExperience: number | null
  /** Verified, founder-supplied answer that resolves sponsorship ambiguity, if one exists (e.g. "OPT/EAD confirmed acceptable at this employer" from a prior recruiter reply). Never inferred. */
  verifiedSponsorshipOverride: boolean
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
    input.minYearsExperienceRequired > JUNIOR_TARGET_MAX_YEARS_REQUIRED
  ) {
    return {
      outcome: 'blocked',
      reason: 'experience_gap_too_large',
      detail: `Posting requires ${input.minYearsExperienceRequired}+ years; exceeds junior/early-career target threshold of ${JUNIOR_TARGET_MAX_YEARS_REQUIRED}.`,
    }
  }

  if (signals.ambiguousSponsorshipLanguage && !input.verifiedSponsorshipOverride) {
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
