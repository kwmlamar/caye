import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { evaluateRecommendationOutcome, type DurableOutcomeEvidence } from './outcomes'
import { isEvidenceSufficient, observationStateAfterAttempt, type RecommendationObservationWindow } from './observation-policy'

/** Code-owned observers only. A recommendation/model may not invent an observer or query. */
export const RECOMMENDATION_OBSERVERS = {
  'research.cadence-effect.v1': true,
} as const

export type RecommendationObserverKey = keyof typeof RECOMMENDATION_OBSERVERS

export type RecommendationObservationPlan =
  | { kind: 'unknown'; expectedEffect: Record<string, unknown> }
  | { kind: 'immediate'; expectedEffect: Record<string, unknown>; evidence: DurableOutcomeEvidence[] }
  | {
      kind: 'later'
      observerKey: RecommendationObserverKey
      expectedEffect: Record<string, unknown>
      firstObservationAt: string
      expiresAt: string
      cadenceSeconds: number
      maxObservations: number
    }

export type ExecutedRecommendationAction = {
  recommendationId: string
  decisionId: string
  workspaceId?: string | null
  executionKey: string
  executionSourceTable: string
  executionSourceId: string
  executedAt?: string | null
  executionProvenance: Record<string, unknown>
  observationPlan: RecommendationObservationPlan
}

function evidenceIdentity(item: DurableOutcomeEvidence) {
  return `${item.evidenceKind}|${item.sourceTable}|${item.sourceId}`
}

async function loadAccumulatedEvidence(recommendationId: string): Promise<DurableOutcomeEvidence[]> {
  const supabase = createServiceClient()
  const { data: outcomes, error: outcomesError } = await supabase
    .from('caye_recommendation_outcomes')
    .select('id')
    .eq('recommendation_id', recommendationId)
  if (outcomesError) throw outcomesError
  const outcomeIds = (outcomes ?? []).map((row: { id: string }) => row.id)
  if (outcomeIds.length === 0) return []

  const { data, error } = await supabase
    .from('caye_recommendation_outcome_evidence')
    .select('evidence_kind,source_table,source_id,observed_at,direction,measurable,measured_delta,unit,followed,provenance')
    .in('outcome_id', outcomeIds)
  if (error) throw error

  return (data ?? []).map((row: any) => ({
    evidenceKind: row.evidence_kind,
    sourceTable: row.source_table,
    sourceId: row.source_id,
    observedAt: row.observed_at,
    direction: row.direction,
    measurable: row.measurable,
    measuredDelta: row.measured_delta,
    unit: row.unit,
    followed: row.followed ?? undefined,
    provenance: row.provenance,
  })) as DurableOutcomeEvidence[]
}

export async function evaluateRecommendationWithAccumulatedEvidence(input: {
  recommendationId: string
  decisionId: string
  workspaceId?: string | null
  evidence: DurableOutcomeEvidence[]
  evaluatorProvenance: Record<string, unknown>
  evaluatedAt?: string | null
}) {
  const previous = await loadAccumulatedEvidence(input.recommendationId)
  const byIdentity = new Map<string, DurableOutcomeEvidence>()
  for (const item of [...previous, ...input.evidence]) byIdentity.set(evidenceIdentity(item), item)
  return evaluateRecommendationOutcome({ ...input, evidence: [...byIdentity.values()] })
}

/**
 * Integration point for the autonomous recommendation executor.
 * A successful action is recorded as followed, never as recommendation success.
 */
export async function recordExecutedRecommendationAction(input: ExecutedRecommendationAction) {
  const executionEvidence: DurableOutcomeEvidence = {
    evidenceKind: 'execution_result',
    sourceTable: input.executionSourceTable,
    sourceId: input.executionSourceId,
    observedAt: input.executedAt ?? new Date().toISOString(),
    direction: 'unknown',
    measurable: false,
    followed: true,
    provenance: input.executionProvenance,
  }

  const immediateEvidence = input.observationPlan.kind === 'immediate' ? input.observationPlan.evidence : []
  const outcome = await evaluateRecommendationWithAccumulatedEvidence({
    recommendationId: input.recommendationId,
    decisionId: input.decisionId,
    workspaceId: input.workspaceId,
    evidence: [executionEvidence, ...immediateEvidence],
    evaluatorProvenance: { kind: 'deterministic_runtime', component: 'recommendation-outcome-observation' },
    evaluatedAt: input.executedAt,
  })

  if (input.observationPlan.kind !== 'later') return { outcome, observation: null }
  if (!(input.observationPlan.observerKey in RECOMMENDATION_OBSERVERS)) throw new Error('unregistered recommendation observer')

  const supabase = createServiceClient()
  const { data: observation, error } = await supabase.rpc('register_caye_recommendation_outcome_observation', {
    p_recommendation_id: input.recommendationId,
    p_decision_id: input.decisionId,
    p_workspace_id: input.workspaceId ?? null,
    p_execution_key: input.executionKey,
    p_observer_key: input.observationPlan.observerKey,
    p_expected_effect: input.observationPlan.expectedEffect,
    p_next_observation_at: input.observationPlan.firstObservationAt,
    p_expires_at: input.observationPlan.expiresAt,
    p_cadence_seconds: input.observationPlan.cadenceSeconds,
    p_max_observations: input.observationPlan.maxObservations,
  })
  if (error) throw error
  return { outcome, observation }
}

/** Feed one claimed code-observed measurement into #372, then close/reschedule the finite observation. */
export async function recordRecommendationObservation(input: {
  observation: RecommendationObservationWindow & {
    id: string
    recommendationId: string
    decisionId: string
    workspaceId?: string | null
    cadenceSeconds: number
    claimToken: string
  }
  evidence: DurableOutcomeEvidence[]
  observedAt?: string
}) {
  const observedAt = input.observedAt ?? new Date().toISOString()
  const outcome = await evaluateRecommendationWithAccumulatedEvidence({
    recommendationId: input.observation.recommendationId,
    decisionId: input.observation.decisionId,
    workspaceId: input.observation.workspaceId,
    evidence: input.evidence,
    evaluatorProvenance: { kind: 'deterministic_runtime', component: 'recommendation-outcome-observation' },
    evaluatedAt: observedAt,
  })

  const state = observationStateAfterAttempt({ observation: input.observation, evidence: input.evidence, now: new Date(observedAt) })
  const next = state === 'pending'
    ? new Date(Date.parse(observedAt) + input.observation.cadenceSeconds * 1000).toISOString()
    : null

  const supabase = createServiceClient()
  const { data: observation, error } = await supabase.rpc('advance_caye_recommendation_outcome_observation', {
    p_observation_id: input.observation.id,
    p_claim_token: input.observation.claimToken,
    p_state: state,
    p_next_observation_at: next,
    p_observed_at: observedAt,
  })
  if (error) throw error
  return { outcome, observation, evidenceSufficient: isEvidenceSufficient(input.evidence) }
}
