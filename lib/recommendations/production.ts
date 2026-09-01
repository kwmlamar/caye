import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import {
  DEFAULT_PROVIDER_FACTORIES,
  resolveResearchProviderPreference,
  supportsResearch,
} from '@/lib/research/providers/config'
import type { ResearchCompletionRequest } from '@/lib/research/providers/types'
import { createGroundedRecommendation } from './service'
import {
  runMaterialRecommendationRuntime,
  type RecommendationBeliefRevisionSnapshot,
  type RecommendationCandidate,
  type RecommendationProposal,
  type RecommendationProposer,
  type RecommendationRuntimeStore,
} from './runtime'

const IMPACT_LOAD_LIMIT = 12
const REVISION_LOAD_LIMIT = 36
const MAX_OUTPUT_TOKENS = 2_400

type DbGoal = { id: string; title: string; description: string | null; status: string; superseded_at: string | null }
type DbItem = { id: string; domain: string; canonical_claim: string; status: string; confidence: number | null; materiality: number | null; valid_until: string | null; provenance: Record<string, unknown> | null }
type DbImpact = { intelligence_item_id: string; goal_id: string; mechanism: string; impact: string; confidence: number; evidence_claim_ids: string[]; synthesis_fingerprint: string }
type DbRevision = { id: string; intelligence_item_id: string; prior_confidence: number | null; revised_confidence: number | null; evidence_role: string; created_at: string }

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(trimmed)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('recommendation proposer returned a non-object payload')
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
      if (!health.usable) { failures.push(`${id}: ${health.detail ?? 'unavailable'}`); continue }
      const result = await adapter.complete(request)
      if (!result.text.trim()) throw new Error('empty completion')
      return result.text
    } catch (error) { failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  throw new Error(`No configured research provider could propose a recommendation. ${failures.join(' | ')}`)
}

function recommendationSystemPrompt(): string {
  return `You are Caye's bounded recommendation proposer. Deterministic code, not you, decides whether anything is persisted.

Use only the supplied canonical goal impact, intelligence item, claim IDs, and belief revisions. Propose one recommendation only when the intelligence supports a concrete course of action that materially advances or protects the active goal.

Rules:
- State the explicit mechanism from intelligence -> goal impact -> proposed action.
- The action must be specific enough that a later observer could tell whether it was done and evaluate the outcome.
- State expected outcome and expected impact separately.
- Preserve contradictions, contested evidence, and uncertainty in the rationale. Never smooth them away.
- Never cite an intelligence ID, claim ID, or belief revision ID not supplied in the input.
- Do not convert weak-signal coincidence into a recommendation.
- Required authority is classification only. It does not authorize execution.
- Return strict JSON only with: title, proposedAction, rationale, expectedOutcome, expectedImpact, urgency, reversibility, risk, confidence, requiredAuthority, supportingIntelligenceIds, supportingClaimIds, supportingBeliefRevisionIds.
- urgency: low | medium | high | immediate
- reversibility: easy | moderate | hard | irreversible
- risk: low | medium | high | critical
- requiredAuthority: { principalType: personal | workspace | business | unknown, principalRef: string | null, resolvedBy: canonical_authority | unresolved }`
}

export const createConfiguredRecommendationProposer = (): RecommendationProposer => async (context) => {
  const text = await routedCompletion({ system: recommendationSystemPrompt(), user: JSON.stringify({ trigger: context.trigger, goal: context.goal, intelligence: context.intelligence, canonicalGoalImpact: context.goalImpact, beliefRevisions: context.beliefRevisions, allowedIntelligenceIds: [context.intelligence.id], allowedClaimIds: context.goalImpact.evidenceClaimIds, allowedBeliefRevisionIds: context.beliefRevisions.map((revision) => revision.id) }), maxOutputTokens: MAX_OUTPUT_TOKENS })
  return parseJsonObject(text) as unknown as RecommendationProposal
}

function revisionSnapshot(revision: DbRevision): RecommendationBeliefRevisionSnapshot {
  return { id: revision.id, priorConfidence: revision.prior_confidence, revisedConfidence: revision.revised_confidence, evidenceRole: revision.evidence_role, createdAt: revision.created_at }
}

async function loadRecommendationCandidates(): Promise<RecommendationCandidate[]> {
  const db = createServiceClient()
  const impactsResult = await db.from('intelligence_goal_impacts').select('intelligence_item_id,goal_id,mechanism,impact,confidence,evidence_claim_ids,synthesis_fingerprint,updated_at').order('updated_at', { ascending: false }).limit(IMPACT_LOAD_LIMIT)
  if (impactsResult.error) throw impactsResult.error
  const impacts = (impactsResult.data ?? []) as DbImpact[]
  if (!impacts.length) return []
  const goalIds = [...new Set(impacts.map((impact) => impact.goal_id))]
  const itemIds = [...new Set(impacts.map((impact) => impact.intelligence_item_id))]
  const [goalsResult, itemsResult, revisionsResult] = await Promise.all([
    db.from('caye_goals').select('id,title,description,status,superseded_at').in('id', goalIds).eq('status', 'active').is('superseded_at', null),
    db.from('intelligence_items').select('id,domain,canonical_claim,status,confidence,materiality,valid_until,provenance').in('id', itemIds).in('status', ['current', 'contested']),
    db.from('intelligence_belief_revisions').select('id,intelligence_item_id,prior_confidence,revised_confidence,evidence_role,created_at').in('intelligence_item_id', itemIds).order('created_at', { ascending: false }).limit(REVISION_LOAD_LIMIT),
  ])
  for (const result of [goalsResult, itemsResult, revisionsResult]) if (result.error) throw result.error
  const goals = new Map(((goalsResult.data ?? []) as DbGoal[]).map((goal) => [goal.id, goal]))
  const items = new Map(((itemsResult.data ?? []) as DbItem[]).map((item) => [item.id, item]))
  const revisions = (revisionsResult.data ?? []) as DbRevision[]
  return impacts.flatMap((impact) => {
    const goal = goals.get(impact.goal_id); const item = items.get(impact.intelligence_item_id)
    if (!goal || !item) return []
    return [{ goal: { id: goal.id, title: goal.title, description: goal.description, status: goal.status, supersededAt: goal.superseded_at }, intelligence: { id: item.id, domain: item.domain, claim: item.canonical_claim, status: item.status, confidence: item.confidence, materiality: item.materiality, validUntil: item.valid_until, provenance: item.provenance ?? {} }, goalImpact: { mechanism: impact.mechanism, impact: impact.impact, confidence: Number(impact.confidence), evidenceClaimIds: impact.evidence_claim_ids ?? [], synthesisFingerprint: impact.synthesis_fingerprint }, beliefRevisions: revisions.filter((revision) => revision.intelligence_item_id === item.id).map(revisionSnapshot), hasCanonicalGoalImpact: true } satisfies RecommendationCandidate]
  })
}

export function createProductionRecommendationStore(): RecommendationRuntimeStore {
  return {
    loadCandidates: loadRecommendationCandidates,
    async hasProposalFingerprint(fingerprint) {
      const db = createServiceClient()
      const result = await db.from('caye_recommendations').select('id').contains('provenance', { proposalFingerprint: fingerprint }).limit(1)
      if (result.error) throw result.error
      return Boolean(result.data?.length)
    },
    async persist(input) {
      const created = await createGroundedRecommendation(input) as { id?: string } | null
      if (!created?.id) throw new Error('grounded recommendation writer returned no recommendation id')
      if (input.provenance?.trigger === 'contradiction-resolution') {
        const db = createServiceClient()
        const result = await db.rpc('supersede_conflicting_caye_recommendations', { p_recommendation_id: created.id })
        if (result.error) throw result.error
      }
      return created
    },
  }
}

export async function runMaterialIntelligenceRecommendations() {
  return runMaterialRecommendationRuntime({ store: createProductionRecommendationStore(), proposer: createConfiguredRecommendationProposer() })
}
