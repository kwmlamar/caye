import type { RecommendationOutcomeEvidence, RecommendationOutcomeStatus } from './outcome-policy'

export type ObservationState = 'pending' | 'satisfied' | 'expired' | 'unknown'
export type MeasurableOutcome = 'positive' | 'negative' | 'no_benefit' | 'unknown'

export type RecommendationObservationWindow = {
  state: ObservationState
  nextObservationAt: string | null
  expiresAt: string
  observationCount: number
  maxObservations: number
}

const objectiveEvidence = (evidence: RecommendationOutcomeEvidence[]) => evidence.filter((item) =>
  (item.evidenceKind === 'system_metric' || item.evidenceKind === 'goal_metric' || item.evidenceKind === 'execution_result') &&
  item.measurable === true &&
  (item.direction === 'positive' || item.direction === 'negative' || item.direction === 'neutral')
)

export function isObservationExpired(observation: RecommendationObservationWindow, now = new Date()): boolean {
  return observation.state === 'expired' || observation.observationCount >= observation.maxObservations || now.getTime() >= Date.parse(observation.expiresAt)
}

export function isObservationDue(observation: RecommendationObservationWindow, now = new Date()): boolean {
  if (observation.state !== 'pending' || isObservationExpired(observation, now) || !observation.nextObservationAt) return false
  return now.getTime() >= Date.parse(observation.nextObservationAt)
}

export function isEvidenceSufficient(evidence: RecommendationOutcomeEvidence[]): boolean {
  return objectiveEvidence(evidence).length > 0
}

export function classifyMeasurableOutcome(evidence: RecommendationOutcomeEvidence[]): MeasurableOutcome {
  const measured = objectiveEvidence(evidence)
  const positive = measured.some((item) => item.direction === 'positive')
  const negative = measured.some((item) => item.direction === 'negative')
  if (positive && negative) return 'unknown'
  if (negative) return 'negative'
  if (positive) return 'positive'
  if (measured.some((item) => item.direction === 'neutral')) return 'no_benefit'
  return 'unknown'
}

export function isOutcomeStillUnknown(evidence: RecommendationOutcomeEvidence[]): boolean {
  return classifyMeasurableOutcome(evidence) === 'unknown'
}

export function observationStateAfterAttempt(input: {
  observation: RecommendationObservationWindow
  evidence: RecommendationOutcomeEvidence[]
  now?: Date
}): ObservationState {
  if (isEvidenceSufficient(input.evidence)) return 'satisfied'
  const nextCount = input.observation.observationCount + 1
  return isObservationExpired({ ...input.observation, observationCount: nextCount }, input.now) ? 'expired' : 'pending'
}

export function measurableOutcomeToRecommendationStatus(outcome: MeasurableOutcome): RecommendationOutcomeStatus {
  if (outcome === 'positive') return 'success'
  if (outcome === 'negative') return 'failure'
  if (outcome === 'no_benefit') return 'no_benefit'
  return 'unknown'
}
