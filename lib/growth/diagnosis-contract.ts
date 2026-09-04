import 'server-only'

export type GrowthEvidenceState = 'observed' | 'unavailable'

export type GrowthMetricEvidence = {
  observationId: string
  metricKey: string
  value: number | null
  observedAt: string
  state: GrowthEvidenceState
  unavailableReason?: string
}

export type GrowthDiagnosisDraft = {
  diagnosisKey: string
  headline: string
  explanation: string
  confidence: number
  evidence: GrowthMetricEvidence[]
  missingSources: string[]
}

/**
 * Rejects diagnoses that pretend missing evidence is evidence.
 * A diagnosis needs at least one genuinely observed metric, and any unavailable
 * metric must remain null with an explicit reason. This is intentionally pure so
 * provider adapters and future reasoning layers can share the same invariant.
 */
export function validateGrowthDiagnosis(draft: GrowthDiagnosisDraft): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) {
    return { ok: false, reason: 'confidence_out_of_range' }
  }

  // Check each item's internal consistency before the aggregate "did we observe
  // anything at all" check below. Otherwise a malformed unavailable item (e.g. a
  // disconnected source reporting value: 0 instead of null) is masked by the
  // generic no_observed_evidence violation instead of surfacing the more specific,
  // more actionable problem: a source lying about having a value.
  for (const item of draft.evidence) {
    if (item.state === 'unavailable' && (item.value !== null || !item.unavailableReason)) {
      return { ok: false, reason: 'unavailable_evidence_must_be_null_and_explained' }
    }
    if (item.state === 'observed' && item.value === null) {
      return { ok: false, reason: 'observed_evidence_requires_value' }
    }
  }

  if (!draft.evidence.some((item) => item.state === 'observed' && item.value !== null)) {
    return { ok: false, reason: 'no_observed_evidence' }
  }

  return { ok: true }
}
