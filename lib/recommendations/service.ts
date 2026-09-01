import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'

export type RecommendationUrgency = 'low' | 'medium' | 'high' | 'immediate'
export type RecommendationReversibility = 'easy' | 'moderate' | 'hard' | 'irreversible'
export type RecommendationRisk = 'low' | 'medium' | 'high' | 'critical'

export type RecommendationAuthority = {
  principalType: 'personal' | 'workspace' | 'business' | 'unknown'
  principalRef: string | null
  resolvedBy: 'canonical_authority' | 'unresolved'
}

export type CreateGroundedRecommendationInput = {
  goalId: string
  title: string
  recommendation: string
  rationale: string
  confidence: number
  expectedImpact: string
  urgency: RecommendationUrgency
  reversibility: RecommendationReversibility
  riskClassification: RecommendationRisk
  requiredAuthority: RecommendationAuthority
  intelligenceItemIds: string[]
  beliefRevisionIds?: string[]
  evidenceClaimIds: string[]
  provenance?: Record<string, unknown>
}

/**
 * Canonical service-side recommendation write path.
 *
 * The database RPC is the authority boundary: it validates active goal state,
 * scope/workspace isolation, canonical intelligence -> goal impact, evidence
 * provenance, revision ownership, confidence ceilings, and idempotency.
 * This wrapper intentionally exposes no browser/client mutation path.
 */
export async function createGroundedRecommendation(input: CreateGroundedRecommendationInput) {
  const db = createServiceClient()
  const { data, error } = await db.rpc('upsert_grounded_caye_recommendation', {
    p_goal_id: input.goalId,
    p_title: input.title,
    p_recommendation: input.recommendation,
    p_rationale: input.rationale,
    p_confidence: input.confidence,
    p_expected_impact: input.expectedImpact,
    p_urgency: input.urgency,
    p_reversibility: input.reversibility,
    p_risk_classification: input.riskClassification,
    p_required_authority: input.requiredAuthority,
    p_intelligence_item_ids: input.intelligenceItemIds,
    p_belief_revision_ids: input.beliefRevisionIds ?? [],
    p_evidence_claim_ids: input.evidenceClaimIds,
    p_provenance: input.provenance ?? {},
  })

  if (error) throw error
  return data
}
