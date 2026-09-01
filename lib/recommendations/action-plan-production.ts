import 'server-only'

import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import {
  DEFAULT_PROVIDER_FACTORIES,
  resolveResearchProviderPreference,
  supportsResearch,
} from '@/lib/research/providers/config'
import type { ResearchCompletionRequest } from '@/lib/research/providers/types'
import {
  executableRecommendationCapabilities,
  validateRecommendationActionPlan,
  type RecommendationActionPlan,
} from './action-plan'

const MAX_OUTPUT_TOKENS = 1_600

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(trimmed)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('action-plan proposer returned a non-object payload')
  return parsed as Record<string, unknown>
}

async function routedCompletion(request: ResearchCompletionRequest): Promise<string> {
  const preference = resolveResearchProviderPreference(process.env)
  const failures: string[] = []
  for (const id of preference.chain) {
    const factory = DEFAULT_PROVIDER_FACTORIES[id]
    if (!factory) continue
    try {
      const adapter = factory()
      if (!supportsResearch(adapter)) continue
      const health = await adapter.checkHealth()
      if (!health.usable) continue
      const result = await adapter.complete(request)
      if (!result.text.trim()) throw new Error('empty completion')
      return result.text
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`No configured research provider could propose an action plan. ${failures.join(' | ')}`)
}

function fingerprint(plan: RecommendationActionPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}

export async function ensureRecommendationActionPlan(recommendationId: string): Promise<RecommendationActionPlan | null> {
  const db = createServiceClient()
  const { data: recommendation, error } = await db
    .from('caye_recommendations')
    .select('id,fingerprint,title,recommendation,rationale,expected_impact,risk_classification,reversibility,required_authority,provenance,status,superseded_at')
    .eq('id', recommendationId)
    .maybeSingle()
  if (error) throw error
  if (!recommendation || recommendation.superseded_at || ['superseded', 'withdrawn'].includes(recommendation.status)) return null

  const provenance = recommendation.provenance && typeof recommendation.provenance === 'object' && !Array.isArray(recommendation.provenance)
    ? recommendation.provenance as Record<string, unknown>
    : {}
  if (provenance.actionPlan) {
    try { return validateRecommendationActionPlan(provenance.actionPlan) } catch { return null }
  }

  const capabilities = executableRecommendationCapabilities()
  if (capabilities.length === 0) return null
  const response = await routedCompletion({
    system: `You map one already-grounded Caye recommendation onto ONE existing registered low-risk capability. You never invent capabilities, code, shell, SQL, URLs, or arguments outside the supplied canonical schema. Return strict JSON only: {"actionPlan": null} when no capability exactly fits, otherwise {"actionPlan":{"capabilityKey":string,"operation":"execute","arguments":object,"expectedEffect":string,"preconditions":string[],"materiality":"quiet"|"material"|"consequential"}}. A plan is only a proposal; deterministic code validates it before persistence or execution.`,
    user: JSON.stringify({
      recommendation: {
        title: recommendation.title,
        proposedAction: recommendation.recommendation,
        rationale: recommendation.rationale,
        expectedImpact: recommendation.expected_impact,
        risk: recommendation.risk_classification,
        reversibility: recommendation.reversibility,
        requiredAuthority: recommendation.required_authority,
      },
      executableCapabilities: capabilities,
    }),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })
  const proposed = parseJsonObject(response).actionPlan
  if (proposed == null) return null
  const plan = validateRecommendationActionPlan(proposed)
  const actionPlanFingerprint = fingerprint(plan)

  const { data: current } = await db
    .from('caye_recommendations')
    .select('fingerprint,provenance,status,superseded_at')
    .eq('id', recommendation.id)
    .maybeSingle()
  if (!current || current.fingerprint !== recommendation.fingerprint || current.superseded_at || ['superseded', 'withdrawn'].includes(current.status)) return null
  const currentProvenance = current.provenance && typeof current.provenance === 'object' && !Array.isArray(current.provenance)
    ? current.provenance as Record<string, unknown>
    : {}
  if (currentProvenance.actionPlan) {
    try { return validateRecommendationActionPlan(currentProvenance.actionPlan) } catch { return null }
  }

  const { error: updateError } = await db
    .from('caye_recommendations')
    .update({
      provenance: {
        ...currentProvenance,
        actionPlan: plan,
        actionPlanFingerprint,
        actionPlanSource: 'bounded-registered-capability-mapper-v1',
        actionPlanCreatedAt: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', recommendation.id)
    .eq('fingerprint', recommendation.fingerprint)
  if (updateError) throw updateError
  return plan
}
