export interface LearningObservationInput {
  id: string
  workspaceId: string
  sourceKind: 'unified_message' | 'operator_message' | string
  sourceId: string
  sourceFingerprint: string
  sourceChannel: string | null
  content: string
  sourceMetadata: Record<string, unknown>
  semanticScope?: string | null
}

export type ObservationEligibility =
  | { eligible: true }
  | { eligible: false; reason: string }

const NEWSLETTER_MARKERS = [
  /\bunsubscribe\b/i,
  /manage (?:your )?(?:subscription|preferences)/i,
  /view (?:this email )?in (?:your )?browser/i,
  /email preferences/i,
]

const SYSTEM_MARKERS = [
  /mailer-daemon/i,
  /delivery status notification/i,
  /password reset/i,
  /verification code/i,
  /security alert/i,
]

const TEST_MARKERS = [
  /\bplatform test\b/i,
  /\bmultimodal test\b/i,
  /\bl-bracket\b/i,
  /\bfea\b/i,
  /caye dashboard screenshot/i,
]

/** Deterministic coarse filter. The extractor gets only legitimate candidates. */
export function evaluateObservationEligibility(input: LearningObservationInput): ObservationEligibility {
  const content = input.content.trim()
  if (!content) return { eligible: false, reason: 'empty content' }

  const semanticScope = String(input.semanticScope ?? input.sourceMetadata.semantic_scope ?? '').toLowerCase()
  if (semanticScope && !['customer_business', 'customer_operator'].includes(semanticScope)) {
    return { eligible: false, reason: `semantic scope ${semanticScope} is not customer-business eligible` }
  }

  const origin = String(input.sourceMetadata.origin ?? input.sourceMetadata.source ?? '').toLowerCase()
  if (/founder_admin|platform_test|engineering_task|personal|system_internal/.test(origin)) {
    return { eligible: false, reason: `origin ${origin} is excluded from customer learning` }
  }

  if (TEST_MARKERS.some((re) => re.test(content))) {
    return { eligible: false, reason: 'platform/founder/engineering test content' }
  }
  if (SYSTEM_MARKERS.some((re) => re.test(content))) {
    return { eligible: false, reason: 'system notification' }
  }

  const newsletterHits = NEWSLETTER_MARKERS.reduce((n, re) => n + (re.test(content) ? 1 : 0), 0)
  if (newsletterHits >= 2) return { eligible: false, reason: 'newsletter/mass-mail pattern' }

  return { eligible: true }
}
