export type RecommendationDecisionState = 'accepted' | 'rejected' | 'deferred' | 'cancelled'
export type OutcomeEvidenceKind = 'system_metric' | 'goal_metric' | 'execution_result' | 'intelligence' | 'research'
export type ObjectiveDirection = 'positive' | 'negative' | 'neutral' | 'unknown'
export type ThesisDirection = 'supports' | 'contradicts' | 'unknown'
export type RecommendationOutcomeStatus = 'success' | 'failure' | 'no_benefit' | 'unknown'
export type RecommendationObjectiveEffect = 'helped' | 'hurt' | 'neutral' | 'unknown'

export type RecommendationOutcomeEvidence = {
  evidenceKind: OutcomeEvidenceKind
  direction: ObjectiveDirection | ThesisDirection
  measurable?: boolean
  followed?: boolean
}

export type RecommendationOutcomeVerdict = {
  status: RecommendationOutcomeStatus
  objectiveEffect: RecommendationObjectiveEffect
  wasFollowed: boolean | null
  contradictedByLaterEvidence: boolean
  evidenceConflict: boolean
}

/** Pure mirror of the durable SQL classification policy. Decision state is context only. */
export function classifyRecommendationOutcome(
  _decision: RecommendationDecisionState,
  evidence: RecommendationOutcomeEvidence[]
): RecommendationOutcomeVerdict {
  let followedTrue = false
  let followedFalse = false
  let objectivePositive = false
  let objectiveNegative = false
  let objectiveNeutral = false
  let contradicted = false

  for (const item of evidence) {
    if (item.evidenceKind === 'intelligence' || item.evidenceKind === 'research') {
      if (item.direction === 'contradicts') contradicted = true
      continue
    }
    if (item.evidenceKind === 'execution_result' && typeof item.followed === 'boolean') {
      if (item.followed) followedTrue = true
      else followedFalse = true
    }
    const gradesObjective = item.evidenceKind === 'system_metric' || item.evidenceKind === 'goal_metric' ||
      (item.evidenceKind === 'execution_result' && item.measurable === true)
    if (!gradesObjective) continue
    if (item.direction === 'positive') objectivePositive = true
    if (item.direction === 'negative') objectiveNegative = true
    if (item.direction === 'neutral') objectiveNeutral = true
  }

  const wasFollowed = followedTrue ? true : followedFalse ? false : null
  const evidenceConflict = objectivePositive && objectiveNegative
  if (evidenceConflict) return { status: 'unknown', objectiveEffect: 'unknown', wasFollowed, contradictedByLaterEvidence: contradicted, evidenceConflict }
  if (objectiveNegative) return { status: 'failure', objectiveEffect: 'hurt', wasFollowed, contradictedByLaterEvidence: contradicted, evidenceConflict }
  if (objectivePositive) return { status: 'success', objectiveEffect: 'helped', wasFollowed, contradictedByLaterEvidence: contradicted, evidenceConflict }
  if (objectiveNeutral) return { status: 'no_benefit', objectiveEffect: 'neutral', wasFollowed, contradictedByLaterEvidence: contradicted, evidenceConflict }
  if (contradicted) return { status: 'failure', objectiveEffect: 'unknown', wasFollowed, contradictedByLaterEvidence: true, evidenceConflict }
  return { status: 'unknown', objectiveEffect: 'unknown', wasFollowed, contradictedByLaterEvidence: false, evidenceConflict }
}

export type CalibrationSample = { confidence: number; status: RecommendationOutcomeStatus }

export function calibrationBucket(confidence: number): string {
  if (confidence <= 0.2) return '0.0-0.2'
  if (confidence <= 0.4) return '0.2-0.4'
  if (confidence <= 0.6) return '0.4-0.6'
  if (confidence <= 0.8) return '0.6-0.8'
  return '0.8-1.0'
}

export function aggregateKnownCalibration(samples: CalibrationSample[]) {
  const known = samples.filter((sample) => sample.status !== 'unknown')
  const buckets = new Map<string, { count: number; confidence: number; successes: number }>()
  for (const sample of known) {
    const key = calibrationBucket(sample.confidence)
    const current = buckets.get(key) ?? { count: 0, confidence: 0, successes: 0 }
    current.count += 1
    current.confidence += sample.confidence
    current.successes += sample.status === 'success' ? 1 : 0
    buckets.set(key, current)
  }
  return {
    evaluatedCount: known.length,
    buckets: [...buckets.entries()].map(([bucket, value]) => ({
      bucket,
      evaluatedCount: value.count,
      averageConfidence: value.confidence / value.count,
      empiricalSuccessRate: value.successes / value.count,
    })),
  }
}
