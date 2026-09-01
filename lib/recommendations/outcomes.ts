import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import type { RecommendationOutcomeEvidence } from './outcome-policy'

export type DurableOutcomeEvidence = RecommendationOutcomeEvidence & {
  sourceTable: string
  sourceId: string
  observedAt?: string | null
  measuredDelta?: number | null
  unit?: string | null
  provenance: Record<string, unknown>
}

export async function evaluateRecommendationOutcome(input: {
  recommendationId: string
  decisionId: string
  workspaceId?: string | null
  evidence: DurableOutcomeEvidence[]
  evaluatorProvenance: Record<string, unknown>
  evaluatedAt?: string | null
}) {
  const supabase = createServiceClient()
  const evidence = input.evidence.map((item) => ({
    evidence_kind: item.evidenceKind,
    source_table: item.sourceTable,
    source_id: item.sourceId,
    observed_at: item.observedAt ?? null,
    direction: item.direction,
    measurable: item.measurable ?? false,
    measured_delta: item.measuredDelta ?? null,
    unit: item.unit ?? null,
    followed: item.followed,
    provenance: item.provenance,
  }))
  const { data, error } = await supabase.rpc('evaluate_caye_recommendation_outcome', {
    p_recommendation_id: input.recommendationId,
    p_decision_id: input.decisionId,
    p_workspace_id: input.workspaceId ?? null,
    p_evidence: evidence,
    p_evaluator_provenance: input.evaluatorProvenance,
    p_evaluated_at: input.evaluatedAt ?? null,
  })
  if (error) throw error
  return data
}

export async function recordRecommendationFounderFeedback(input: {
  recommendationId: string
  decisionId?: string | null
  outcomeId?: string | null
  workspaceId?: string | null
  usefulness?: 'useful' | 'not_useful' | 'mixed' | 'unknown' | null
  timing?: 'too_early' | 'on_time' | 'too_late' | 'unknown' | null
  noisiness?: 'material' | 'too_noisy' | 'unknown' | null
  feedback?: string | null
  provenance: Record<string, unknown>
}) {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('record_caye_recommendation_founder_feedback', {
    p_recommendation_id: input.recommendationId,
    p_decision_id: input.decisionId ?? null,
    p_outcome_id: input.outcomeId ?? null,
    p_workspace_id: input.workspaceId ?? null,
    p_usefulness: input.usefulness ?? null,
    p_timing: input.timing ?? null,
    p_noisiness: input.noisiness ?? null,
    p_feedback: input.feedback ?? null,
    p_provenance: input.provenance,
  })
  if (error) throw error
  return data
}

/** Structured calibration context for future recommendation generation. */
export async function getRecommendationCalibration(workspaceId?: string | null) {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('get_caye_recommendation_calibration', {
    p_workspace_id: workspaceId ?? null,
  })
  if (error) throw error
  return data
}
