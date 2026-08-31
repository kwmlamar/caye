import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { ingestIntelligenceFinding } from '@/lib/intelligence/ingest'
import { queueResearchRun } from './runtime'
import {
  CROSS_DOMAIN_SYNTHESIS_DESK,
  type ConstituentIntelligence,
  type SourceQuality,
  type SynthesisCandidate,
  type WildcardCandidate,
} from './cross-domain'
import {
  CROSS_DOMAIN_BELIEF_REVISION_LIMIT,
  CROSS_DOMAIN_CANDIDATE_LIMIT,
  CROSS_DOMAIN_CLAIM_LIMIT,
  CROSS_DOMAIN_RELATION_LIMIT,
  runCrossDomainSynthesis,
  type CrossDomainContext,
  type CrossDomainProposalBundle,
  type CrossDomainReasoner,
  type CrossDomainRuntimeStore,
} from './cross-domain-runtime'
import {
  DEFAULT_PROVIDER_FACTORIES,
  resolveResearchProviderPreference,
  supportsResearch,
} from './providers/config'
import type { ResearchCompletionRequest } from './providers/types'

const MATERIAL_BELIEF_DELTA = 0.15
const MATERIAL_ITEM_THRESHOLD = 0.7
const MAX_REASONER_OUTPUT_TOKENS = 5_000

type DbItem = {
  id: string
  domain: string
  topic: string
  canonical_claim: string
  epistemic_type: string
  confidence: number | null
  materiality: number | null
  relevance: number | null
  observed_at: string
  provenance: Record<string, unknown> | null
}

type ExistingRelation = {
  from_item_id: string
  to_item_id: string
  relation_type: string
  confidence: number | null
}

function sourceQuality(value: unknown): SourceQuality {
  switch (value) {
    case 'official':
    case 'academic-preprint':
    case 'academic-institution':
    case 'primary':
    case 'independent':
    case 'community':
      return value
    default:
      return 'unknown'
  }
}

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function materialityScore(value: 'low' | 'medium' | 'high' | 'critical'): number {
  return ({ low: 0.25, medium: 0.5, high: 0.8, critical: 1 })[value]
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(trimmed)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('cross-domain reasoner returned a non-object payload')
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
      if (!health.usable) {
        failures.push(`${id}: ${health.detail ?? 'unavailable'}`)
        continue
      }
      const result = await adapter.complete(request)
      if (!result.text.trim()) throw new Error('empty completion')
      return result.text
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new Error(`No configured research provider could run cross-domain synthesis. ${failures.join(' | ')}`)
}

function reasonerSystemPrompt(): string {
  return `You are Caye's bounded cross-domain synthesis proposer. You may propose connections, second-order implications, contradictions, blind spots, weak-signal patterns, objective impacts, and follow-up research. You are not the epistemic gate: deterministic code will reject unsupported proposals.

Rules:
- Use only the supplied canonical durable intelligence and active objectives.
- Cross-domain synthesis must use at least two supplied intelligence item IDs from distinct domains.
- mechanismEvidenceIds must be constituent item IDs and must cross domain boundaries.
- Never use causal unless the evidence actually supports a causal mechanism. Prefer strategic or constraint when causality is uncertain.
- affectedTargets may reference only supplied active objective IDs or supplied monitored domain IDs.
- Preserve counterarguments and contradictory evidence rather than smoothing them away.
- Do not infer objective relevance from vibes. State the explicit mechanism.
- Prefer a few material proposals over many weak coincidences.
- Follow-up research must be phrased as questions, not claims.
- Return strict JSON only.`
}

export const createConfiguredCrossDomainReasoner = (): CrossDomainReasoner => async (context) => {
  const enriched = context as CrossDomainContext & { existingRelations?: ExistingRelation[] }
  const evidence = context.evidence.map((item) => ({
    id: item.id,
    domain: item.domain,
    statement: item.statement,
    epistemicKind: item.epistemicKind,
    confidence: item.confidence,
    sourceQuality: item.sourceQuality,
    sourceIds: item.sourceIds,
    independenceKeys: item.independenceKeys,
    observedAt: item.observedAt,
    stance: item.stance,
    tags: item.tags,
    assumptions: item.assumptions,
  }))

  const user = JSON.stringify({
    mission: CROSS_DOMAIN_SYNTHESIS_DESK.standingMission,
    trigger: context.trigger,
    evidence,
    existingRelations: enriched.existingRelations ?? [],
    activeObjectives: context.activeObjectives,
    monitoredDomains: context.monitoredDomains,
    recentBeliefRevisionIds: context.recentBeliefRevisionIds,
    weakSignalCandidates: context.weakSignals.map((signal) => ({
      id: signal.id,
      domain: signal.domain,
      statement: signal.statement,
      patternKey: signal.patternKey,
      mechanism: signal.mechanism,
      confidence: signal.confidence,
      sourceIds: signal.sourceIds,
      independenceKeys: signal.independenceKeys,
    })),
    outputContract: {
      syntheses: 'Array<SynthesisCandidate>',
      wildcards: 'Array<WildcardCandidate>',
      synthesisCandidateRequiredFields: [
        'id','constituentIds','connectionKind','inferredConnection','mechanism','mechanismEvidenceIds',
        'assumptions','counterarguments','implications','recommendedFollowUpResearch','affectedTargets',
        'confidence','materiality','novelty',
      ],
      connectionKinds: ['causal','strategic','constraint','contradiction','weak-signal-pattern'],
      materiality: ['low','medium','high','critical'],
      novelty: ['known','incremental','novel','wildcard'],
      affectedTargetKinds: ['objective','domain'],
    },
  })

  const text = await routedCompletion({ system: reasonerSystemPrompt(), user, maxOutputTokens: MAX_REASONER_OUTPUT_TOKENS })
  const payload = parseJsonObject(text)
  return {
    syntheses: Array.isArray(payload.syntheses) ? payload.syntheses as SynthesisCandidate[] : [],
    wildcards: Array.isArray(payload.wildcards) ? payload.wildcards as WildcardCandidate[] : [],
  } satisfies CrossDomainProposalBundle
}

async function itemClaimMap(itemIds: string[]): Promise<Record<string, string[]>> {
  if (!itemIds.length) return {}
  const db = createServiceClient()
  const { data, error } = await db
    .from('intelligence_item_claims')
    .select('intelligence_item_id,claim_id')
    .in('intelligence_item_id', itemIds)
  if (error) throw error
  const result: Record<string, string[]> = {}
  for (const edge of data ?? []) {
    const id = String(edge.intelligence_item_id)
    result[id] = [...new Set([...(result[id] ?? []), String(edge.claim_id)])]
  }
  return result
}

async function buildContext(): Promise<CrossDomainContext & { existingRelations: ExistingRelation[] }> {
  const db = createServiceClient()
  const itemsResult = await db
    .from('intelligence_items')
    .select('id,domain,topic,canonical_claim,epistemic_type,confidence,materiality,relevance,observed_at,provenance')
    .in('status', ['current','contested'])
    .order('materiality', { ascending: false })
    .order('relevance', { ascending: false })
    .order('observed_at', { ascending: false })
    .limit(CROSS_DOMAIN_CANDIDATE_LIMIT)
  if (itemsResult.error) throw itemsResult.error
  const items = (itemsResult.data ?? []) as DbItem[]
  const itemIds = items.map((item) => item.id)

  const [goalsResult, relationsResult, edgesResult, revisionsResult, latestSynthesisResult] = await Promise.all([
    db.from('caye_goals').select('id,title,description,priority').eq('scope','operator').eq('status','active').is('superseded_at', null),
    itemIds.length
      ? db.from('intelligence_relations').select('from_item_id,to_item_id,relation_type,confidence').or(`from_item_id.in.(${itemIds.join(',')}),to_item_id.in.(${itemIds.join(',')})`).eq('status','active').order('created_at',{ascending:false}).limit(CROSS_DOMAIN_RELATION_LIMIT)
      : Promise.resolve({ data: [], error: null }),
    itemIds.length
      ? db.from('intelligence_item_claims').select('intelligence_item_id,role,claim_id,research_claims(id,source_quality,research_claim_evidence(source_id,stance))').in('intelligence_item_id', itemIds).limit(CROSS_DOMAIN_CLAIM_LIMIT * 3)
      : Promise.resolve({ data: [], error: null }),
    db.from('intelligence_belief_revisions').select('id,intelligence_item_id,prior_confidence,revised_confidence,evidence_role,created_at').order('created_at',{ascending:false}).limit(CROSS_DOMAIN_BELIEF_REVISION_LIMIT),
    db.from('intelligence_items').select('updated_at').eq('domain','cross-domain').contains('provenance',{kind:'cross-domain-synthesis'}).order('updated_at',{ascending:false}).limit(1).maybeSingle(),
  ])
  for (const result of [goalsResult, relationsResult, edgesResult, revisionsResult, latestSynthesisResult]) if (result.error) throw result.error

  const relations = (relationsResult.data ?? []) as ExistingRelation[]
  const edgesByItem = new Map<string, Array<Record<string, unknown>>>()
  for (const raw of edgesResult.data ?? []) {
    const edge = raw as unknown as Record<string, unknown>
    const key = String(edge.intelligence_item_id)
    edgesByItem.set(key, [...(edgesByItem.get(key) ?? []), edge])
  }

  const evidence: ConstituentIntelligence[] = items.map((item) => {
    const edges = edgesByItem.get(item.id) ?? []
    const claims = edges.map((edge) => edge.research_claims).filter(Boolean) as Array<Record<string, unknown>>
    const sourceIds = [...new Set(claims.flatMap((claim) => {
      const claimEvidence = Array.isArray(claim.research_claim_evidence) ? claim.research_claim_evidence as Array<Record<string, unknown>> : []
      return claimEvidence.map((entry) => String(entry.source_id)).filter(Boolean)
    }))]
    const qualities = claims.map((claim) => sourceQuality(claim.source_quality))
    const quality = qualities.find((value) => value === 'official' || value === 'primary' || value === 'academic-institution') ?? qualities[0] ?? 'unknown'
    const related = relations.filter((relation) => relation.from_item_id === item.id || relation.to_item_id === item.id)
    const provenance = item.provenance ?? {}
    const weak = provenance.weak_signal && typeof provenance.weak_signal === 'object' ? provenance.weak_signal as Record<string, unknown> : null
    return {
      id: item.id,
      domain: item.domain,
      statement: item.canonical_claim,
      epistemicKind: ['observed_source_fact','source_claim','corroborated_claim'].includes(item.epistemic_type) ? 'source_fact' : 'inference',
      confidence: numeric(item.confidence, 0.5),
      sourceQuality: quality,
      sourceIds,
      independenceKeys: sourceIds,
      observedAt: item.observed_at,
      tags: related.map((relation) => `relation:${relation.relation_type}:${relation.from_item_id === item.id ? relation.to_item_id : relation.from_item_id}`),
      patternKey: typeof weak?.patternKey === 'string' ? weak.patternKey : undefined,
      mechanism: typeof weak?.mechanism === 'string' ? weak.mechanism : undefined,
    } as ConstituentIntelligence & { patternKey?: string; mechanism?: string }
  })

  const latestSynthesisAt = latestSynthesisResult.data?.updated_at ? Date.parse(String(latestSynthesisResult.data.updated_at)) : 0
  const materialRevision = (revisionsResult.data ?? []).find((revision) => {
    const item = items.find((candidate) => candidate.id === revision.intelligence_item_id)
    const delta = Math.abs(numeric(revision.revised_confidence) - numeric(revision.prior_confidence))
    return Date.parse(String(revision.created_at)) > latestSynthesisAt
      && numeric(item?.materiality) >= MATERIAL_ITEM_THRESHOLD
      && (delta >= MATERIAL_BELIEF_DELTA || ['contradicts','supersedes'].includes(String(revision.evidence_role)))
  })

  return {
    evidence,
    activeObjectives: (goalsResult.data ?? []).map((goal) => ({ id: String(goal.id), title: String(goal.title), description: goal.description, priority: goal.priority })),
    monitoredDomains: [...new Set(items.map((item) => item.domain))],
    weakSignals: evidence.filter((item) => Boolean((item as ConstituentIntelligence & { patternKey?: string }).patternKey)) as Array<ConstituentIntelligence & { patternKey?: string; mechanism?: string }>,
    recentBeliefRevisionIds: (revisionsResult.data ?? []).map((revision) => String(revision.id)),
    trigger: materialRevision ? 'material-belief-change' : 'periodic',
    existingRelations: relations,
  }
}

export function createProductionCrossDomainStore(): CrossDomainRuntimeStore {
  return {
    loadContext: buildContext,

    claimIdsForItems: itemClaimMap,

    async persistSynthesis(artifact, fingerprint) {
      const db = createServiceClient()
      const claimMap = await itemClaimMap(artifact.constituentIntelligence.map((item) => item.id))
      const evidence = [...new Set(Object.values(claimMap).flat())].map((claimId) => ({ claimId, role: 'supports' as const }))
      const provenance = {
        kind: 'cross-domain-synthesis',
        synthesisFingerprint: fingerprint,
        constituentItemIds: artifact.constituentIntelligence.map((item) => item.id),
        connectionKind: artifact.connectionKind,
        mechanism: artifact.mechanism,
        assumptions: artifact.assumptions,
        counterarguments: artifact.counterarguments,
        implications: artifact.implications,
        affectedTargets: artifact.affectedTargets,
        contradictoryEvidenceIds: artifact.contradictoryEvidence.map((item) => item.id),
      }
      const result = await ingestIntelligenceFinding({
        scope: { kind: 'operator' },
        domain: 'cross-domain',
        topic: [...new Set(artifact.constituentIntelligence.map((item) => item.domain))].sort().join(' + '),
        claim: artifact.inferredConnection,
        epistemicType: 'inference',
        confidence: artifact.confidence,
        relevance: artifact.affectedTargets.some((target) => target.kind === 'objective') ? 1 : 0.65,
        novelty: artifact.novelty === 'wildcard' ? 1 : artifact.novelty === 'novel' ? 0.8 : artifact.novelty === 'incremental' ? 0.5 : 0.2,
        materiality: materialityScore(artifact.materiality),
        evidence,
        provenance,
      })
      const previousFingerprint = result.item?.provenance?.synthesisFingerprint
      const changed = !result.deduplicated || previousFingerprint !== fingerprint
      if (changed) {
        const update = await db.from('intelligence_items').update({ provenance, updated_at: new Date().toISOString() }).eq('id', result.item.id)
        if (update.error) throw update.error
      }
      return { itemId: String(result.item.id), fingerprint, changed }
    },

    async persistGroundedRelation(input) {
      const db = createServiceClient()
      const { error } = await db.rpc('upsert_grounded_intelligence_relation', {
        p_from_item_id: input.synthesisItemId,
        p_to_item_id: input.constituentItemId,
        p_relation_type: input.relationType,
        p_confidence: input.confidence,
        p_evidence_claim_ids: input.evidenceClaimIds,
        p_provenance: { source: 'cross-domain-synthesis', synthesisFingerprint: input.fingerprint },
      })
      if (error) throw error
    },

    async linkObjectiveImpact(input) {
      const db = createServiceClient()
      const { error } = await db.rpc('upsert_grounded_intelligence_goal_impact', {
        p_intelligence_item_id: input.synthesisItemId,
        p_goal_id: input.goalId,
        p_mechanism: input.mechanism,
        p_impact: input.impact,
        p_confidence: input.confidence,
        p_evidence_claim_ids: input.evidenceClaimIds,
        p_synthesis_fingerprint: input.fingerprint,
        p_provenance: { source: 'cross-domain-synthesis' },
      })
      if (error) throw error
    },

    async queueFollowUpResearch(input) {
      const goalId = input.affectedTargets.find((target) => target.kind === 'objective')?.id
      if (!goalId) return
      const db = createServiceClient()
      const program = await db.from('research_programs').upsert({
        goal_id: goalId,
        title: 'Cross-domain follow-up',
        scope: 'operator',
        intelligence_scope: 'operator',
        status: 'active',
      }, { onConflict: 'goal_id,title' }).select('id').single()
      if (program.error) throw program.error
      const question = await db.from('research_questions').upsert({
        program_id: program.data.id,
        question: input.question,
        status: 'open',
      }, { onConflict: 'program_id,question' }).select('id').single()
      if (question.error) throw question.error
      await queueResearchRun(String(question.data.id), `cross-domain:${input.synthesisItemId}`)
    },

    async persistWildcard(decision, fingerprint) {
      const candidate = decision.candidate
      const claimMap = await itemClaimMap(candidate.evidence.map((item) => item.id))
      const evidence = [...new Set(Object.values(claimMap).flat())].map((claimId) => ({ claimId, role: 'supports' as const }))
      await ingestIntelligenceFinding({
        scope: { kind: 'operator' },
        domain: candidate.discoveredDomain,
        topic: `wildcard:${candidate.category}`,
        claim: decision.epistemicPath.synthesis,
        epistemicType: 'inference',
        confidence: candidate.confidence,
        relevance: 0.7,
        novelty: 1,
        materiality: materialityScore(candidate.materiality),
        evidence,
        provenance: {
          kind: 'cross-domain-wildcard',
          wildcardFingerprint: fingerprint,
          relevancePath: candidate.relevancePath,
          monitoringGap: decision.monitoringGap,
          evidenceItemIds: candidate.evidence.map((item) => item.id),
        },
      })
    },

    async raiseStrategicAttention(input) {
      const db = createServiceClient()
      const existing = await db.from('intelligence_goal_impacts')
        .select('goal_id,attention_fingerprint')
        .eq('intelligence_item_id', input.synthesisItemId)
      if (existing.error) throw existing.error
      const stale = (existing.data ?? []).filter((row) => row.attention_fingerprint !== input.fingerprint)
      if (!stale.length) return false
      const { error } = await db.from('intelligence_goal_impacts').update({
        attention_required: true,
        attention_fingerprint: input.fingerprint,
        attention_changed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        provenance: { attentionTitle: input.title, attentionSummary: input.summary, materiality: input.materiality },
      }).eq('intelligence_item_id', input.synthesisItemId).in('goal_id', stale.map((row) => row.goal_id))
      if (error) throw error
      return true
    },
  }
}

export async function crossDomainSynthesisDue(): Promise<{ due: boolean; reason: 'periodic' | 'material-belief-change' | 'not-due' }> {
  const db = createServiceClient()
  const latest = await db.from('intelligence_items').select('updated_at')
    .eq('domain','cross-domain').contains('provenance',{kind:'cross-domain-synthesis'})
    .order('updated_at',{ascending:false}).limit(1).maybeSingle()
  if (latest.error) throw latest.error
  if (!latest.data) return { due: true, reason: 'periodic' }

  const lastAt = Date.parse(String(latest.data.updated_at))
  const elapsedHours = (Date.now() - lastAt) / 3_600_000
  if (elapsedHours >= CROSS_DOMAIN_SYNTHESIS_DESK.cadence.synthesisIntervalHours) return { due: true, reason: 'periodic' }

  const revisions = await db.from('intelligence_belief_revisions')
    .select('intelligence_item_id,prior_confidence,revised_confidence,evidence_role,created_at,intelligence_items(materiality)')
    .gt('created_at', new Date(lastAt).toISOString())
    .order('created_at',{ascending:false})
    .limit(CROSS_DOMAIN_BELIEF_REVISION_LIMIT)
  if (revisions.error) throw revisions.error
  const material = (revisions.data ?? []).some((revision) => {
    const item = Array.isArray(revision.intelligence_items) ? revision.intelligence_items[0] : revision.intelligence_items
    const delta = Math.abs(numeric(revision.revised_confidence) - numeric(revision.prior_confidence))
    return numeric(item?.materiality) >= MATERIAL_ITEM_THRESHOLD
      && (delta >= MATERIAL_BELIEF_DELTA || ['contradicts','supersedes'].includes(String(revision.evidence_role)))
  })
  return material ? { due: true, reason: 'material-belief-change' } : { due: false, reason: 'not-due' }
}

export async function runCrossDomainSynthesisIfDue() {
  const due = await crossDomainSynthesisDue()
  if (!due.due) return { status: 'idle' as const, reason: due.reason }
  const result = await runCrossDomainSynthesis({
    store: createProductionCrossDomainStore(),
    reasoner: createConfiguredCrossDomainReasoner(),
  })
  return { status: 'completed' as const, dueReason: due.reason, ...result }
}
