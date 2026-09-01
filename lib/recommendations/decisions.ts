import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'

export type RecommendationDecision = 'accepted' | 'rejected' | 'deferred' | 'cancelled'
export type RecommendationDecisionActor = 'founder' | 'operator' | 'system'

export interface RecordRecommendationDecisionInput {
  recommendationId: string
  decision: RecommendationDecision
  actorKind: RecommendationDecisionActor
  actorId?: string | null
  rationale?: string | null
  authorityProvenance?: Record<string, unknown>
  workspaceId?: string | null
  idempotencyKey?: string | null
  decidedAt?: string | null
}

export async function recordRecommendationDecision(input: RecordRecommendationDecisionInput) {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('record_caye_recommendation_decision', {
    p_recommendation_id: input.recommendationId,
    p_decision: input.decision,
    p_actor_kind: input.actorKind,
    p_actor_id: input.actorId ?? null,
    p_rationale: input.rationale ?? null,
    p_authority_provenance: input.authorityProvenance ?? {},
    p_workspace_id: input.workspaceId ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
    p_decided_at: input.decidedAt ?? null,
  })

  if (error) throw error
  return data
}
