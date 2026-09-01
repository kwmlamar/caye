import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { recommendationExecutionEligible } from '@/lib/recommendations/decisions'
import { startCanonicalCodingSession } from './start'

type CanonicalRecommendationRow = {
  id: string
  scope: 'operator' | 'workspace'
  workspace_id: string | null
  title: string
  recommendation: string
  rationale: string
  status: 'proposed' | 'accepted' | 'rejected' | 'deferred' | 'withdrawn' | 'superseded'
  fingerprint: string
  provenance: Record<string, unknown>
}

export function deriveCanonicalCodingTask(row: Pick<CanonicalRecommendationRow, 'title' | 'recommendation' | 'rationale'>): string {
  return [
    `Implement canonical recommendation: ${row.title.trim()}`,
    `Required change: ${row.recommendation.trim()}`,
    `Grounding: ${row.rationale.trim()}`,
    'Keep the change bounded. Preserve existing authority, security, payment, migration, messaging, and approval boundaries. Do not merge or deploy.',
  ].join('\n\n')
}

/** The only recommendation -> autonomous coding-session entry point. */
export async function startCodingSessionForRecommendation(input: {
  recommendationId: string
  workspaceId: string | null
}): Promise<{ sessionId: string }> {
  const db = createServiceClient()
  const { data, error } = await db
    .from('caye_recommendations')
    .select('id,scope,workspace_id,title,recommendation,rationale,status,fingerprint,provenance')
    .eq('id', input.recommendationId)
    .maybeSingle<CanonicalRecommendationRow>()
  if (error) throw error
  if (!data) throw new Error('Canonical recommendation not found')
  if (data.status !== 'accepted') throw new Error('Canonical recommendation is not accepted')

  const expectedWorkspace = data.scope === 'workspace' ? data.workspace_id : null
  if (expectedWorkspace !== input.workspaceId) throw new Error('Canonical recommendation workspace mismatch')
  if (!await recommendationExecutionEligible(data.id, input.workspaceId)) {
    throw new Error('Canonical recommendation is not execution eligible')
  }

  return startCanonicalCodingSession({
    recommendationId: data.id,
    recommendationFingerprint: data.fingerprint,
    workspaceId: input.workspaceId,
    task: deriveCanonicalCodingTask(data),
    provenance: {
      source: 'canonical-recommendation-execution',
      recommendationId: data.id,
      recommendationFingerprint: data.fingerprint,
      recommendationProvenance: data.provenance ?? {},
      executionEligibility: 'caye_recommendation_execution_eligible',
    },
  })
}
