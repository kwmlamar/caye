/**
 * Job-search operator (CAY-194 / #194) — real ATS application-submission
 * execution. Shared domain types for the executor, providers, preflight,
 * and claim modules.
 *
 * Founder-only, same isolation rule as the rest of lib/job-search: nothing
 * here ever carries a per-workspace scope column, and nothing here is
 * reachable from customer-facing (front-desk) code paths. See
 * lib/job-search/leakage.test.ts (CAY-192) and this PR's
 * lib/job-search/execution/isolation.test.ts, which extends the same
 * structural scan to this subtree.
 */

export type ExecutorOutcome = 'submitted' | 'needs_human' | 'submission_uncertain' | 'failed' | 'preflight_blocked'

export type ExecutionProvider = 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'generic'

/** One provider-neutral, deterministically-discovered ATS form field. */
export type DiscoveredField = {
  /** The provider's own identifier for this field (e.g. Greenhouse's numeric question id). */
  providerFieldId: string
  label: string
  /** Our normalized semantic key, when we can confidently map the label to one (e.g. 'sponsorship', 'phone'). Null when unmapped — never guessed. */
  semanticKey: string | null
  inputType: 'text' | 'textarea' | 'select' | 'multi_select' | 'boolean' | 'file' | 'unknown'
  required: boolean
  /**
   * The provider's own option list for a select/multi-select field, with the
   * provider's option IDENTIFIER preserved alongside the human label.
   *
   * Storing only labels (as this originally did) is not merely lossy, it is
   * wrong: verified against a real Greenhouse board on 2026-08-29, the same
   * board returns `{"label":"No","value":0}` for one question and
   * `{"label":"No","value":239207523002}` for another. Greenhouse's submission
   * API expects the option's `value`, never the label, so a label-only field
   * can never be turned into a correct answer — and a label that happens to
   * match across two questions carries no shared meaning at all.
   */
  allowedOptions: { label: string; value: string }[] | null
  /** 0-1. Reflects confidence in the semantic-key mapping, not in any resolved value. */
  confidence: number
}

export type FieldResolution =
  | { status: 'resolved'; field: DiscoveredField; value: string; source: 'profile_fact'; profileFactId: string; reusable: true }
  | { status: 'resolved'; field: DiscoveredField; value: string; source: 'application_specific'; reusable: false }
  | { status: 'unresolved'; field: DiscoveredField; reason: string }

export type DomainValidation = {
  url: string
  hostname: string | null
  allowed: boolean
  reason: string
}

export type HumanReviewBlocker = {
  category: string
  label: string
  reason: string
}

/** Discovery result for one candidate's ATS apply page/API. */
export type FieldDiscoveryResult =
  | { outcome: 'clear'; fields: DiscoveredField[]; domainValidations: DomainValidation[] }
  | { outcome: 'prohibited_destination'; domainValidations: DomainValidation[]; reason: string }
  | { outcome: 'captcha_detected'; domainValidations: DomainValidation[]; reason: string }
  | { outcome: 'anti_bot_detected'; domainValidations: DomainValidation[]; reason: string }
  | { outcome: 'malformed_url'; reason: string }
  | { outcome: 'unsupported_provider'; reason: string }
  | { outcome: 'discovery_failed'; reason: string; retryable: boolean }

export type SubmissionEvidence = {
  /** A provider-verifiable confirmation identifier. Never fabricated — absence of this means the outcome cannot be 'submitted'. */
  confirmationId: string
  method: 'ats_api_response' | 'browser_confirmation'
  receivedAt: string
  /** Non-sensitive metadata only (e.g. HTTP status). Never raw form field values. */
  raw?: Record<string, unknown>
}

export type SubmissionResult =
  /**
   * The provider has no safe, authorized way to submit this application at
   * all — not a transient failure and never retryable. Greenhouse returns
   * this unconditionally today: its Job Board submission endpoint requires
   * the EMPLOYER's own Job Board API key as HTTP Basic Auth, which an
   * outside applicant cannot hold. See providers/greenhouse.ts.
   */
  | { outcome: 'not_supported'; reason: string }
  | { outcome: 'submitted'; evidence: SubmissionEvidence; response: Record<string, unknown> }
  | { outcome: 'submission_uncertain'; reason: string; response?: Record<string, unknown> }
  | { outcome: 'failed'; reason: string; retryable: boolean; response?: Record<string, unknown> }
  | { outcome: 'captcha_detected'; reason: string }
  | { outcome: 'anti_bot_detected'; reason: string }
  | { outcome: 'prohibited_destination'; reason: string; domainValidations: DomainValidation[] }

export type ResumeArtifactForSubmission = {
  id: string
  applicationId: string
  variantId: string | null
  content: string
  artifactType: 'resume'
}

export type FounderContactInfo = {
  fullName: string
  email: string
  phone: string | null
}

/**
 * Provider-neutral submission request — the executor builds this once;
 * providers never see anything beyond it. Only ever constructed and passed
 * to a provider's submit() when the rollout's dry_run flag is false — a
 * dry run stops at field discovery + answer resolution and never reaches
 * this type at all, so there is no dry-run branch inside any provider to
 * accidentally get wrong.
 */
export type SubmissionRequest = {
  applicationId: string
  candidateId: string
  applyUrl: string
  resume: ResumeArtifactForSubmission
  coverLetter: string | null
  answers: FieldResolution[]
  founder: FounderContactInfo
}

export const HIGH_RISK_FIELD_SEMANTIC_KEYS = [
  'sponsorship',
  'work_authorization',
  'citizenship',
  'clearance',
  'criminal_history',
  'disability',
  'veteran_status',
  'demographic',
  'relocation',
  'compensation',
  'legal_attestation',
  'willingness_to_travel',
  'drivers_license',
  'availability_start_date',
  'background_check_acknowledgment',
  'arbitration_acknowledgment',
] as const

export type HighRiskSemanticKey = (typeof HIGH_RISK_FIELD_SEMANTIC_KEYS)[number]
