/**
 * Job-search operator (#192) — deterministic 0-100 explainable scoring.
 * Policy gates remain authoritative over the numeric score.
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
  extraScreenerQuestionCount: number
} & Pick<PolicyGateInput, 'founderYearsExperience' | 'verifiedSponsorshipOverride' | 'experienceRequirementIsHard'> & {
    signals: PolicyGateInput['signals']
  }

const EARLY_CAREER = /\b(entry[ -]?level|new grad(?:uate)?|junior|associate|engineer i|engineer 1|developer i|developer 1|l1|level 1|tier 1|frontline)\b/i
const SENIOR = /\b(senior|sr\.?|staff|principal|lead|manager|director|architect)\b/i
const SUPPORT_FAMILY = /\b(support|help ?desk|service desk)\b/i
const SUPPORT_ROLE = /\b(engineer|technician|specialist|analyst|representative|support)\b/i
const NON_US_REGION = /\b(apac|emea|eu|europe|united kingdom|uk|london|hong kong|shanghai|singapore|beijing|seoul|tokyo|kuala lumpur|israel|tel aviv|canada|toronto|vancouver|india|australia|sydney|latam|latin america)\b/i
const US_REGION = /\b(united states|u\.?s\.?a?|usa|us remote|remote us)\b/i

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function isSupportFamily(title: string): boolean {
  return SUPPORT_FAMILY.test(title) && SUPPORT_ROLE.test(title)
}

function titleFitScore(title: string, targetTitles: string[]): number {
  const normalized = normalizeTitle(title)
  const targets = targetTitles.map(normalizeTitle)
  if (targets.some((target) => normalized.includes(target))) return 20

  const targetsSupportFamily = targets.some((target) => isSupportFamily(target) || /\bit support\b|\bhelp ?desk\b/.test(target))
  if (isSupportFamily(normalized) && targetsSupportFamily) {
    return SENIOR.test(title) ? 5 : 20
  }

  const isSoftwareFamily = /\b(software|backend|full ?stack|application)\b/.test(normalized) && /\b(engineer|developer)\b/.test(normalized)
  const targetsSoftwareFamily = targets.some((target) => /\b(software|backend|full ?stack|application)\b/.test(target))
  if (isSoftwareFamily && targetsSoftwareFamily && EARLY_CAREER.test(title)) return 20

  // A senior title must not outrank an explicitly early-career target merely
  // because both contain "engineer". Experience parsing can add a separate
  // hard/soft penalty when the posting provides years.
  if (SENIOR.test(title) && targets.some((target) => EARLY_CAREER.test(target))) return 5
  if (/engineer|developer/i.test(title)) return 10
  return 0
}

function stackOverlapScore(title: string, candidateSkills: string[], founderSkills: string[]): number {
  // Support postings often enumerate products, protocols, ticketing systems,
  // and customer-facing duties rather than a conventional programming stack.
  // Treat sparse/no-overlap extraction as unknown-neutral for that role family
  // instead of pretending it is evidence of a bad technical fit.
  if (candidateSkills.length === 0) return 8
  const founderSet = new Set(founderSkills.map((s) => s.toLowerCase()))
  const overlap = candidateSkills.filter((s) => founderSet.has(s.toLowerCase())).length
  const score = Math.round((overlap / candidateSkills.length) * 18)
  return isSupportFamily(normalizeTitle(title)) ? Math.max(8, score) : score
}
function degreeFitScore(r: ScoringInput['requiresDegree'], has: boolean): number { if (r === 'unknown' || r === 'none') return 10; if (r === 'preferred') return has ? 10 : 7; return has ? 10 : 0 }
function experienceGapPenalty(title: string, required: number | null, founderYears: number | null): number {
  if (required === null) return 0
  // Explicit L1/junior/entry/frontline roles asking for <=2 years are still
  // early-career jobs. Do not convert a conventional "1-2 years" wish list
  // into a 5-10 point punishment. Hard >5-year requirements remain enforced
  // separately by policy-gate.ts and 3+ year gaps still score normally.
  if (EARLY_CAREER.test(title) && required <= 2) return 0
  const gap = required - (founderYears ?? 0)
  return gap <= 0 ? 0 : Math.min(15, gap * 5)
}
function locationFitScore(i: ScoringInput): number {
  if (i.remoteType === 'remote') {
    const location = i.location ?? ''
    // "Remote" is not synonymous with "remote from the United States".
    // Region-locked EU/APAC/etc postings should not receive the full remote
    // score merely because the ATS includes the word Remote in the label.
    if (NON_US_REGION.test(location) && !US_REGION.test(location)) return i.founderOpenToRelocation ? 4 : 0
    return 12
  }
  if (i.founderOpenToRemoteOnly) return 0
  if (i.remoteType === 'hybrid') return i.founderOpenToRelocation ? 9 : 6
  if (i.remoteType === 'on_site') return i.founderOpenToRelocation ? 6 : 2
  return 5
}
function compensationFitScore(i: ScoringInput): number { if (i.salaryMin === null || i.founderMinAcceptableSalary === null) return 5; return i.salaryMin >= i.founderMinAcceptableSalary ? 10 : 2 }
function recencyScore(postedAt: string | null, discoveredAt: string): number { if (!postedAt) return 5; const p = new Date(postedAt).getTime(), d = new Date(discoveredAt).getTime(); if (Number.isNaN(p) || Number.isNaN(d)) return 5; const h = (d-p)/3600000; if (h <= 72) return 10; if (h <= 168) return 6; return 2 }
function complexityPenalty(n: number): number { return Math.min(5, n) }

export function scoreCandidate(input: ScoringInput): ScoringResult {
  const gate = evaluatePolicyGate({ signals: input.signals, minYearsExperienceRequired: input.minYearsExperienceRequired, founderYearsExperience: input.founderYearsExperience, verifiedSponsorshipOverride: input.verifiedSponsorshipOverride, experienceRequirementIsHard: input.experienceRequirementIsHard })
  const breakdown: ScoreBreakdown = { titleFit: titleFitScore(input.title,input.targetTitles), stackOverlap: stackOverlapScore(input.title,input.candidateSkills,input.founderSkills), degreeFit: degreeFitScore(input.requiresDegree,input.founderHasDegree), experienceGapPenalty: experienceGapPenalty(input.title,input.minYearsExperienceRequired,input.founderYearsExperience), workAuthFit: gate.outcome === 'clear' ? 15 : 0, locationFit: locationFitScore(input), compensationFit: compensationFitScore(input), recency: recencyScore(input.postedAt,input.discoveredAt), complexityPenalty: complexityPenalty(input.extraScreenerQuestionCount) }
  const rawScore = breakdown.titleFit + breakdown.stackOverlap + breakdown.degreeFit + breakdown.workAuthFit + breakdown.locationFit + breakdown.compensationFit + breakdown.recency - breakdown.experienceGapPenalty - breakdown.complexityPenalty
  const score = Math.max(0, Math.min(100, Math.round(rawScore)))
  const rejectionReasons: string[] = []
  if (gate.outcome === 'blocked') { rejectionReasons.push(hardBlockReasonToRejection(gate)); return { score, breakdown, bucket:'reject', gate, rejectionReasons } }
  if (gate.outcome === 'needs_human') return { score, breakdown, bucket:'review_low_priority', gate, rejectionReasons:[] }
  if (score >= SCORE_BUCKETS.AUTO_QUEUE_MIN) return { score, breakdown, bucket:'auto_queue', gate, rejectionReasons }
  if (score >= SCORE_BUCKETS.QUEUE_IF_CAPACITY_MIN) return { score, breakdown, bucket:'queue_if_capacity', gate, rejectionReasons }
  if (score >= SCORE_BUCKETS.REVIEW_MIN) return { score, breakdown, bucket:'review_low_priority', gate, rejectionReasons }
  rejectionReasons.push('Below minimum fit threshold')
  return { score, breakdown, bucket:'reject', gate, rejectionReasons }
}
