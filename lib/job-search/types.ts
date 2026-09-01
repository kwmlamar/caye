/**
 * Job-search operator (CAY-192 / GitHub #192) — shared domain types.
 *
 * Founder-only, isolated capability. Nothing here has a per-customer
 * scope column and nothing here should ever be imported by customer-
 * facing (front-desk) code paths — each module carries its own boundary
 * note instead of a single barrel file, to keep accidental cross-import
 * obvious at the call site.
 */

export type CandidateStatus =
  | 'DISCOVERED'
  | 'SCORED'
  | 'REJECTED'
  | 'QUEUED'
  | 'HUMAN_REVIEW'

export type ApplicationStatus =
  | 'PREPARED'
  | 'APPLYING'
  | 'NEEDS_HUMAN'
  | 'SUBMITTED'
  | 'SUBMISSION_UNCERTAIN'
  | 'FAILED'
  | 'FOLLOWUP_DUE'
  | 'INTERVIEW'
  | 'REJECTED'
  | 'OFFER'

export type RemoteType = 'remote' | 'hybrid' | 'on_site' | 'unknown'

/** Raw posting shape a source adapter returns, before normalization. */
export type RawJobPosting = {
  sourceKey: string
  sourceUrl: string
  applyUrl: string
  company: string
  title: string
  requisitionId?: string | null
  location?: string | null
  remoteType?: RemoteType
  employmentType?: string | null
  salary?: { min?: number; max?: number; currency?: string } | null
  description?: string | null
  requirements?: string | null
  postedAt?: string | null
}

/** Normalized candidate, after canonicalization but before scoring. */
export type NormalizedCandidate = RawJobPosting & {
  canonicalKey: string
}

export type WorkAuthSignals = {
  /** Explicit "no OPT / no CPT / sponsorship not available" language found. */
  optExcluded: boolean
  /** Explicit "must be a U.S. citizen" (or equivalent) language found. */
  citizenshipRequired: boolean
  /** Explicit active security clearance requirement found. */
  clearanceRequired: boolean
  /**
   * Sponsorship/work-authorization/citizenship/clearance-eligibility
   * language present but not clearly resolvable either way by the
   * deterministic hard-block patterns. This is the fallback the whole
   * gate leans on: any topic-relevant language the hard-block patterns
   * didn't recognize lands here rather than silently falling through as
   * `clear` — see policy-gate.ts's AMBIGUOUS_* pattern lists.
   */
  ambiguousEligibilityLanguage: boolean
  /** Free-text evidence snippets backing the flags above, for founder explainability. */
  evidence: string[]
}

export type RoleFamily =
  | 'software_engineer'
  | 'support_engineer'
  | 'help_desk'
  | 'devops_infrastructure'
  | 'qa_test'
  | 'unknown'

export type HardBlockReason =
  | 'opt_excluded'
  | 'citizenship_required'
  | 'clearance_required'
  | 'experience_gap_too_large'
  | 'location_mismatch'

export type RejectionReason =
  | 'hard_blocker_opt_excluded'
  | 'hard_blocker_citizenship_required'
  | 'hard_blocker_clearance_required'
  | 'hard_blocker_experience_gap'
  | 'hard_blocker_location_mismatch'
  | 'policy_gate_ambiguous_work_auth'
  | 'score_title_mismatch'
  | 'score_stack_mismatch'
  | 'score_seniority_mismatch'
  | 'score_degree_required_not_held'
  | 'score_location_not_preferred'
  | 'score_salary_below_minimum'
  | 'score_too_old'
  | 'score_too_complex'
  | 'score_below_threshold'

export type PolicyGateResult =
  | { outcome: 'blocked'; reason: HardBlockReason; detail: string }
  | { outcome: 'needs_human'; reason: 'ambiguous_work_authorization'; detail: string }
  | { outcome: 'clear' }

export type ScoreBreakdown = {
  titleFit: number
  stackOverlap: number
  degreeFit: number
  experienceGapPenalty: number
  workAuthFit: number
  locationFit: number
  compensationFit: number
  recency: number
  complexityPenalty: number
  familyBonus: number
}

export type ScoringContext = {
  roleFamily: RoleFamily
  titleFamilyMatch: boolean
}

export type ScoringResult = {
  score: number
  breakdown: ScoreBreakdown
  bucket: 'auto_queue' | 'queue_if_capacity' | 'review_low_priority' | 'reject'
  gate: PolicyGateResult
  rejectionReasons: string[]
}

export const SCORE_BUCKETS = {
  AUTO_QUEUE_MIN: 85,
  QUEUE_IF_CAPACITY_MIN: 70,
  REVIEW_MIN: 50,
} as const

/** Domains automation must never touch for application submission. */
export const PROHIBITED_APPLY_DOMAINS = ['linkedin.com', 'indeed.com'] as const

export type ProfileFactCategory =
  | 'work_authorization'
  | 'citizenship'
  | 'clearance'
  | 'relocation'
  | 'compensation'
  | 'demographic'
  | 'disability'
  | 'veteran'
  | 'criminal_history'
  | 'attestation'
  | 'general'

/** High-risk categories: never answerable by inference, only by a verified fact. */
export const HIGH_RISK_ANSWER_CATEGORIES: ProfileFactCategory[] = [
  'work_authorization',
  'citizenship',
  'clearance',
  'relocation',
  'compensation',
  'demographic',
  'disability',
  'veteran',
  'criminal_history',
  'attestation',
]

export type ProfileFactRow = {
  id: string
  profile_id: string
  canonical_key: string
  category: ProfileFactCategory
  question: string
  answer: string
  source: 'founder-direct' | 'resume-derived' | 'inferred'
  last_verified_at: string
  superseded_at: string | null
}

/** A single required application field the executor must resolve or escalate. */
export type RequiredField = {
  key: string
  question: string
  category: ProfileFactCategory
}

/** Signal reported by whatever executes the actual browser/ATS step (none in v1 — see application-executor.ts doc comment). */
export type ExecutionSignal =
  | { kind: 'captcha_detected' }
  | { kind: 'anti_bot_detected' }
  | { kind: 'identity_verification_required' }
  | { kind: 'unknown_required_field'; field: string }
  | { kind: 'clear' }
