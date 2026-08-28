/**
 * Job-search operator (#192) — deterministic 0-100 explainable scoring.
 *
 * Order of operations is load-bearing: evaluatePolicyGate() runs FIRST.
 * A `blocked` gate result forces the final bucket to `reject` regardless
 * of the numeric score — the score is still computed and returned (for
 * founder explainability, "why did you skip this one") but it can never
 * promote a hard-blocked candidate into a queueable bucket. A
 * `needs_human` gate result forces `review_low_priority` regardless of
 * score, so an ambiguous-sponsorship posting never auto-queues just
 * because it scores 95 on every other axis.
 */
import { evaluatePolicyGate, hardBlockReasonToRejection, type PolicyGateInput } from './policy-gate'
import { SCORE_BUCKETS, type ScoreBreakdown, type ScoringResult } from './types'

export type ScoringInput = {
  title: string
  targetTitles: string[]
  candidateSkills: string[]
  founderSkills: string[]
  requiresDegree: 'none' | 'preferred' | 'required' | 'unknown'
  founderHasDegree: boolean
  minYearsExperienceRequired: number | null
  founderYearsExperience: number | null
  location: string | null
  remoteType: 'remote' | 'hybrid' | 'on_site' | 'unknown'
  founderOpenToRelocation: boolean
  founderOpenToRemoteOnly: boolean
  salaryMin: number | null
  founderMinAcceptableSalary: number | null
  postedAt: string | null
  discoveredAt: string
  /** Rough proxy for "application complexity" — count of custom/free-text screener questions beyond the standard set, when known. */
  extraScreenerQuestionCount: number
} & Pick<PolicyGateInput, 'founderYearsExperience' | 'verifiedSponsorshipOverride'> & {
    signals: PolicyGateInput['signals']
  }

function titleFitScore(title: string, targetTitles: string[]): number {
  const normalized = title.toLowerCase()
  const hit = targetTitles.some((target) => normalized.includes(target.toLowerCase()))
  if (hit) return 20
  // Partial credit for generic engineering titles that didn't match a target verbatim.
  if (/engineer|developer/i.test(title)) return 10
  return 0
}

function stackOverlapScore(candidateSkills: string[], founderSkills: string[]): number {
  if (candidateSkills.length === 0) return 8 // unknown stack, neutral-ish credit
  const founderSet = new Set(founderSkills.map((s) => s.toLowerCase()))
  const overlap = candidateSkills.filter((s) => founderSet.has(s.toLowerCase())).length
  const ratio = overlap / candidateSkills.length
  return Math.round(ratio * 18)
}

function degreeFitScore(requiresDegree: ScoringInput['requiresDegree'], founderHasDegree: boolean): number {
  if (requiresDegree === 'unknown' || requiresDegree === 'none') return 10
  if (requiresDegree === 'preferred') return founderHasDegree ? 10 : 7
  return founderHasDegree ? 10 : 0
}

function experienceGapPenalty(required: number | null, founderYears: number | null): number {
  if (required === null) return 0
  const founder = founderYears ?? 0
  const gap = required - founder
  if (gap <= 0) return 0
  return Math.min(15, gap * 5)
}

function locationFitScore(input: ScoringInput): number {
  if (input.remoteType === 'remote') return 12
  if (input.founderOpenToRemoteOnly) return 0
  if (input.remoteType === 'hybrid') return input.founderOpenToRelocation ? 9 : 6
  if (input.remoteType === 'on_site') return input.founderOpenToRelocation ? 6 : 2
  return 5
}

function compensationFitScore(input: ScoringInput): number {
  if (input.salaryMin === null || input.founderMinAcceptableSalary === null) return 5 // unknown, neutral
  return input.salaryMin >= input.founderMinAcceptableSalary ? 10 : 2
}

function recencyScore(postedAt: string | null, discoveredAt: string): number {
  if (!postedAt) return 5
  const posted = new Date(postedAt).getTime()
  const discovered = new Date(discoveredAt).getTime()
  if (Number.isNaN(posted) || Number.isNaN(discovered)) return 5
  const ageHours = (discovered - posted) / (1000 * 60 * 60)
  if (ageHours <= 72) return 10
  if (ageHours <= 24 * 7) return 6
  return 2
}

function complexityPenalty(extraScreenerQuestionCount: number): number {
  return Math.min(5, extraScreenerQuestionCount)
}

export function scoreCandidate(input: ScoringInput): ScoringResult {
  const gate = evaluatePolicyGate({
    signals: input.signals,
    minYearsExperienceRequired: input.minYearsExperienceRequired,
    founderYearsExperience: input.founderYearsExperience,
    verifiedSponsorshipOverride: input.verifiedSponsorshipOverride,
  })

  const breakdown: ScoreBreakdown = {
    titleFit: titleFitScore(input.title, input.targetTitles),
    stackOverlap: stackOverlapScore(input.candidateSkills, input.founderSkills),
    degreeFit: degreeFitScore(input.requiresDegree, input.founderHasDegree),
    experienceGapPenalty: experienceGapPenalty(input.minYearsExperienceRequired, input.founderYearsExperience),
    workAuthFit: gate.outcome === 'clear' ? 15 : 0,
    locationFit: locationFitScore(input),
    compensationFit: compensationFitScore(input),
    recency: recencyScore(input.postedAt, input.discoveredAt),
    complexityPenalty: complexityPenalty(input.extraScreenerQuestionCount),
  }

  const rawScore =
    breakdown.titleFit +
    breakdown.stackOverlap +
    breakdown.degreeFit +
    breakdown.workAuthFit +
    breakdown.locationFit +
    breakdown.compensationFit +
    breakdown.recency -
    breakdown.experienceGapPenalty -
    breakdown.complexityPenalty

  const score = Math.max(0, Math.min(100, Math.round(rawScore)))
  const rejectionReasons: string[] = []

  // The gate is authoritative and cannot be overridden by score. This is
  // the single point that enforces "150/day target does not lower the
  // minimum quality/legal threshold" and "hard blockers cannot be
  // outscored" — both regression-tested directly against this function.
  if (gate.outcome === 'blocked') {
    rejectionReasons.push(hardBlockReasonToRejection(gate))
    return { score, breakdown, bucket: 'reject', gate, rejectionReasons }
  }

  if (gate.outcome === 'needs_human') {
    return { score, breakdown, bucket: 'review_low_priority', gate, rejectionReasons: [] }
  }

  if (score >= SCORE_BUCKETS.AUTO_QUEUE_MIN) {
    return { score, breakdown, bucket: 'auto_queue', gate, rejectionReasons }
  }
  if (score >= SCORE_BUCKETS.QUEUE_IF_CAPACITY_MIN) {
    return { score, breakdown, bucket: 'queue_if_capacity', gate, rejectionReasons }
  }
  if (score >= SCORE_BUCKETS.REVIEW_MIN) {
    return { score, breakdown, bucket: 'review_low_priority', gate, rejectionReasons }
  }
  rejectionReasons.push('Below minimum fit threshold')
  return { score, breakdown, bucket: 'reject', gate, rejectionReasons }
}
