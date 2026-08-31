import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export type IntelligenceRelationType = 'related' | 'corroborates' | 'contradicts' | 'supersedes' | 'causes' | 'implicates'
export type EvidenceRole = 'supports' | 'contradicts' | 'context'

export type IntelligenceItemSnapshot = {
  id: string
  workspace_id: string | null
  scope: 'global' | 'operator' | 'workspace'
  domain: string
  topic: string
  canonical_claim: string
  semantic_key: string
  confidence: number | null
  materiality: number | null
  relevance: number | null
  observed_at: string
  valid_from: string
  valid_until: string | null
  status: string
  provenance?: Record<string, unknown> | null
}

export type ClaimSnapshot = {
  id: string
  semantic_key?: string | null
  normalized_statement?: string | null
  observed_at?: string | null
  source_id?: string | null
  provenance?: Record<string, unknown> | null
  [key: string]: unknown
}

export type RelationCandidate = {
  item: IntelligenceItemSnapshot
  score: number
  reasons: string[]
  claimIds: string[]
}

export type RelationProposal = {
  fromItemId: string
  toItemId: string
  relationType: IntelligenceRelationType
  rationale: string
  supportingResearchClaimIds: string[]
  confidence: number
}

export type RelationProposalContext = {
  newItem: IntelligenceItemSnapshot
  newItemClaimIds: string[]
  candidates: RelationCandidate[]
}

export type RelationProposer = (context: RelationProposalContext) => Promise<RelationProposal[]>

export type ValidatedRelationProposal = RelationProposal & {
  confidence: number
  evidenceIdentityCount: number
}

const MAX_CANDIDATES = 16
const QUERY_LIMIT = 36
const HIGH_MATERIALITY = 0.65
const MATERIAL_REVISION_DELTA = 0.025
const MAX_CORROBORATION_DELTA = 0.08
const MAX_CONTRADICTION_DELTA = 0.07
const MAX_SUPERSESSION_DELTA = 0.12
const CAUSAL_MIN_CONFIDENCE = 0.85
const CAUSAL_MIN_INDEPENDENT_EVIDENCE = 2

const STOP_WORDS = new Set(['the','a','an','and','or','of','to','for','in','on','at','by','with','from','as','is','are','was','were','be','been','being','that','this','it','its'])

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((token) => token.length > 2 && !STOP_WORDS.has(token)))
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / Math.min(a.size, b.size)
}

function sameScope(a: IntelligenceItemSnapshot, b: IntelligenceItemSnapshot): boolean {
  return a.scope === b.scope && a.workspace_id === b.workspace_id
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function provenanceString(provenance: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!provenance) return null
  for (const key of keys) {
    const value = provenance[key]
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase()
  }
  return null
}

/**
 * Evidence identity is deliberately source/article oriented rather than claim-id oriented.
 * Two rows produced from the same article remain one independent piece of evidence.
 */
export function evidenceIdentity(claim: ClaimSnapshot): string {
  const provenance = claim.provenance ?? undefined
  const article = provenanceString(provenance, ['canonicalUrl','canonical_url','url','sourceUrl','source_url','articleUrl','article_url'])
  if (article) return `article:${article}`
  if (typeof claim.source_id === 'string' && claim.source_id) return `source:${claim.source_id}`
  const source = provenanceString(provenance, ['sourceId','source_id','source','publisher'])
  if (source) return `source:${source}`
  if (claim.semantic_key) return `claim:${String(claim.semantic_key)}`
  return `claim-id:${claim.id}`
}

export function rankCandidate(newItem: IntelligenceItemSnapshot, candidate: IntelligenceItemSnapshot, sharedClaimCount = 0, isExistingNeighbor = false): RelationCandidate | null {
  if (newItem.id === candidate.id || !sameScope(newItem, candidate)) return null

  const topicOverlap = overlap(tokens(newItem.topic), tokens(candidate.topic))
  const claimOverlap = overlap(tokens(newItem.canonical_claim), tokens(candidate.canonical_claim))
  const sameDomain = newItem.domain === candidate.domain
  const highMateriality = Number(candidate.materiality ?? 0) >= HIGH_MATERIALITY

  // Structural gate. Text similarity alone is not enough to enter the neighborhood.
  if (!sameDomain && sharedClaimCount === 0 && !isExistingNeighbor) return null
  if (topicOverlap === 0 && sharedClaimCount === 0 && !isExistingNeighbor) return null

  const reasons: string[] = []
  let score = 0
  if (sameDomain) { score += 0.22; reasons.push('same_domain') }
  if (topicOverlap > 0) { score += Math.min(0.32, topicOverlap * 0.4); reasons.push('topic_overlap') }
  if (claimOverlap > 0) { score += Math.min(0.16, claimOverlap * 0.2); reasons.push('claim_overlap') }
  if (sharedClaimCount > 0) { score += Math.min(0.3, sharedClaimCount * 0.12); reasons.push('shared_research_claim') }
  if (highMateriality) { score += 0.08; reasons.push('high_materiality') }
  if (isExistingNeighbor) { score += 0.2; reasons.push('existing_relation') }

  return { item: candidate, score: clamp(score), reasons, claimIds: [] }
}

export function boundCandidates(candidates: RelationCandidate[], limit = MAX_CANDIDATES): RelationCandidate[] {
  return [...candidates]
    .sort((a, b) => b.score - a.score || timestamp(b.item.observed_at) - timestamp(a.item.observed_at) || a.item.id.localeCompare(b.item.id))
    .slice(0, Math.max(0, Math.min(MAX_CANDIDATES, limit)))
}

function confidenceCeiling(independentEvidence: number, relationType: IntelligenceRelationType): number {
  if (independentEvidence <= 1) return relationType === 'causes' ? 0 : 0.68
  if (independentEvidence === 2) return relationType === 'causes' ? 0.86 : 0.84
  return relationType === 'causes' ? 0.9 : 0.92
}

export function validateRelationProposal(input: {
  proposal: RelationProposal
  newItem: IntelligenceItemSnapshot
  candidate: IntelligenceItemSnapshot
  allowedClaimIds: Set<string>
  claimsById: Map<string, ClaimSnapshot>
}): ValidatedRelationProposal {
  const { proposal, newItem, candidate, allowedClaimIds, claimsById } = input
  if (proposal.fromItemId === proposal.toItemId) throw new Error('relation endpoints must be distinct')
  const endpoints = new Set([proposal.fromItemId, proposal.toItemId])
  if (!endpoints.has(newItem.id) || !endpoints.has(candidate.id) || endpoints.size !== 2) throw new Error('proposal endpoints are outside the bounded candidate pair')
  if (!sameScope(newItem, candidate)) throw new Error('cross-scope or cross-workspace relation rejected')
  if (!proposal.rationale.trim()) throw new Error('relation rationale is required')
  if (!proposal.supportingResearchClaimIds.length) throw new Error('relation requires research claim evidence')
  if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) throw new Error('invalid relation confidence')

  const uniqueClaimIds = [...new Set(proposal.supportingResearchClaimIds)]
  for (const claimId of uniqueClaimIds) {
    if (!allowedClaimIds.has(claimId) || !claimsById.has(claimId)) throw new Error('arbitrary or ungrounded research claim rejected')
  }

  const identities = new Set(uniqueClaimIds.map((id) => evidenceIdentity(claimsById.get(id)!)))
  const independentEvidence = identities.size
  const ceiling = confidenceCeiling(independentEvidence, proposal.relationType)

  if (proposal.relationType === 'causes') {
    if (independentEvidence < CAUSAL_MIN_INDEPENDENT_EVIDENCE || proposal.confidence < CAUSAL_MIN_CONFIDENCE) {
      throw new Error('causal relation rejected: stronger independent evidence required')
    }
    const from = proposal.fromItemId === newItem.id ? newItem : candidate
    const to = proposal.toItemId === newItem.id ? newItem : candidate
    if (timestamp(from.observed_at) >= timestamp(to.observed_at) && timestamp(from.valid_from) >= timestamp(to.valid_from)) {
      throw new Error('causal relation rejected: temporal ordering is not supported')
    }
  }

  if (proposal.relationType === 'supersedes') {
    const newer = proposal.fromItemId === newItem.id ? newItem : candidate
    const older = proposal.toItemId === newItem.id ? newItem : candidate
    if (timestamp(newer.observed_at) <= timestamp(older.observed_at)) throw new Error('supersession requires newer evidence to point to the older belief')
  }

  return {
    ...proposal,
    supportingResearchClaimIds: uniqueClaimIds,
    confidence: Math.min(proposal.confidence, ceiling),
    evidenceIdentityCount: independentEvidence,
  }
}

export function computeBeliefRevision(input: {
  relationType: IntelligenceRelationType
  relationConfidence: number
  independentEvidence: number
  priorConfidence: number | null
  targetMateriality: number | null
}): { revisedConfidence: number; delta: number; role: EvidenceRole } | null {
  const prior = input.priorConfidence
  if (prior == null || !Number.isFinite(prior)) return null
  if (!['corroborates','contradicts','supersedes'].includes(input.relationType)) return null

  // One source, or two rows derived from the same article, is not enough to move durable belief state.
  if (input.independentEvidence < 2) return null

  const strength = clamp(input.relationConfidence) * Math.min(1, input.independentEvidence / 3)
  const materiality = clamp(Number(input.targetMateriality ?? 0.5), 0.25, 1)
  let signedDelta = 0
  let role: EvidenceRole = 'context'

  if (input.relationType === 'corroborates') {
    signedDelta = Math.min(MAX_CORROBORATION_DELTA, 0.075 * strength * materiality)
    role = 'supports'
  } else if (input.relationType === 'contradicts') {
    signedDelta = -Math.min(MAX_CONTRADICTION_DELTA, 0.065 * strength * materiality)
    role = 'contradicts'
  } else {
    signedDelta = -Math.min(MAX_SUPERSESSION_DELTA, 0.11 * strength * materiality)
    role = 'contradicts'
  }

  if (Math.abs(signedDelta) < MATERIAL_REVISION_DELTA) return null
  const revised = clamp(prior + signedDelta)
  return { revisedConfidence: Number(revised.toFixed(3)), delta: Number((revised - prior).toFixed(3)), role }
}

function defaultProposals(context: RelationProposalContext): RelationProposal[] {
  const proposals: RelationProposal[] = []
  for (const candidate of context.candidates) {
    const shared = candidate.claimIds.filter((id) => context.newItemClaimIds.includes(id))
    const evidence = [...new Set([...context.newItemClaimIds, ...candidate.claimIds])]
    if (!evidence.length) continue

    if (shared.length > 0) {
      proposals.push({
        fromItemId: context.newItem.id,
        toItemId: candidate.item.id,
        relationType: 'corroborates',
        rationale: 'Items are grounded by overlapping canonical research claims.',
        supportingResearchClaimIds: evidence,
        confidence: 0.62,
      })
      continue
    }

    if (candidate.score >= 0.48) {
      proposals.push({
        fromItemId: context.newItem.id,
        toItemId: candidate.item.id,
        relationType: 'related',
        rationale: `Bounded structural neighborhood overlap: ${candidate.reasons.join(', ')}.`,
        supportingResearchClaimIds: evidence,
        confidence: Math.min(0.62, 0.42 + candidate.score * 0.2),
      })
    }
  }
  return proposals
}

async function loadClaimIdsForItems(db: any, itemIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (!itemIds.length) return result
  const { data, error } = await db.from('intelligence_item_claims').select('intelligence_item_id,claim_id').in('intelligence_item_id', itemIds)
  if (error) throw error
  for (const row of data ?? []) {
    const values = result.get(row.intelligence_item_id) ?? []
    values.push(row.claim_id)
    result.set(row.intelligence_item_id, values)
  }
  return result
}

async function loadClaims(db: any, claimIds: string[]): Promise<Map<string, ClaimSnapshot>> {
  const result = new Map<string, ClaimSnapshot>()
  if (!claimIds.length) return result
  const { data, error } = await db.from('research_claims').select('*').in('id', claimIds)
  if (error) throw error
  for (const claim of data ?? []) result.set(claim.id, claim)
  return result
}

export async function findBoundedRelationCandidates(db: any, newItem: IntelligenceItemSnapshot): Promise<RelationCandidate[]> {
  let query = db.from('intelligence_items').select('*')
    .eq('scope', newItem.scope)
    .eq('domain', newItem.domain)
    .neq('id', newItem.id)
    .in('status', ['current','contested'])
    .order('materiality', { ascending: false })
    .order('observed_at', { ascending: false })
    .limit(QUERY_LIMIT)
  query = newItem.workspace_id == null ? query.is('workspace_id', null) : query.eq('workspace_id', newItem.workspace_id)
  const nearby = await query
  if (nearby.error) throw nearby.error

  const relations = await db.from('intelligence_relations')
    .select('from_item_id,to_item_id')
    .or(`from_item_id.eq.${newItem.id},to_item_id.eq.${newItem.id}`)
    .eq('status','active')
    .limit(MAX_CANDIDATES)
  if (relations.error) throw relations.error
  const neighborIds = new Set<string>()
  for (const relation of relations.data ?? []) neighborIds.add(relation.from_item_id === newItem.id ? relation.to_item_id : relation.from_item_id)

  const initialIds = [newItem.id, ...(nearby.data ?? []).map((item: any) => item.id)]
  const claimIdsByItem = await loadClaimIdsForItems(db, initialIds)
  const newClaims = new Set(claimIdsByItem.get(newItem.id) ?? [])

  const ranked: RelationCandidate[] = []
  for (const raw of nearby.data ?? []) {
    const candidate = raw as IntelligenceItemSnapshot
    const candidateClaims = claimIdsByItem.get(candidate.id) ?? []
    const shared = candidateClaims.filter((claimId) => newClaims.has(claimId)).length
    const rankedCandidate = rankCandidate(newItem, candidate, shared, neighborIds.has(candidate.id))
    if (rankedCandidate) ranked.push({ ...rankedCandidate, claimIds: candidateClaims })
  }
  return boundCandidates(ranked)
}

export async function runPostIngestionIntelligenceFormation(input: {
  itemId: string
  proposer?: RelationProposer
  db?: any
}): Promise<{ candidateCount: number; relationIds: string[]; revisionIds: string[]; rejected: number }> {
  const db = input.db ?? createServiceClient()
  const loaded = await db.from('intelligence_items').select('*').eq('id', input.itemId).single()
  if (loaded.error) throw loaded.error
  const newItem = loaded.data as IntelligenceItemSnapshot

  const candidates = await findBoundedRelationCandidates(db, newItem)
  if (!candidates.length) return { candidateCount: 0, relationIds: [], revisionIds: [], rejected: 0 }

  const claimIdsByItem = await loadClaimIdsForItems(db, [newItem.id, ...candidates.map((candidate) => candidate.item.id)])
  const newItemClaimIds = claimIdsByItem.get(newItem.id) ?? []
  const hydratedCandidates = candidates.map((candidate) => ({ ...candidate, claimIds: claimIdsByItem.get(candidate.item.id) ?? candidate.claimIds }))
  const allClaimIds = [...new Set([newItemClaimIds, ...hydratedCandidates.map((candidate) => candidate.claimIds)].flat())]
  const claimsById = await loadClaims(db, allClaimIds)

  const proposer = input.proposer ?? (async (context: RelationProposalContext) => defaultProposals(context))
  const proposals = await proposer({ newItem, newItemClaimIds, candidates: hydratedCandidates })
  const candidateById = new Map(hydratedCandidates.map((candidate) => [candidate.item.id, candidate]))
  const relationIds: string[] = []
  const revisionIds: string[] = []
  let rejected = 0

  // One proposal per candidate/type is enough. The database also enforces idempotent relation identity.
  const seen = new Set<string>()
  for (const proposal of proposals.slice(0, MAX_CANDIDATES * 2)) {
    const otherId = proposal.fromItemId === newItem.id ? proposal.toItemId : proposal.fromItemId
    const candidate = candidateById.get(otherId)
    if (!candidate) { rejected += 1; continue }
    const dedupeKey = `${proposal.fromItemId}:${proposal.toItemId}:${proposal.relationType}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    try {
      const endpointClaimIds = new Set([...newItemClaimIds, ...candidate.claimIds])
      const validated = validateRelationProposal({ proposal, newItem, candidate: candidate.item, allowedClaimIds: endpointClaimIds, claimsById })
      const relation = await db.rpc('upsert_grounded_intelligence_relation', {
        p_from_item_id: validated.fromItemId,
        p_to_item_id: validated.toItemId,
        p_relation_type: validated.relationType,
        p_confidence: validated.confidence,
        p_evidence_claim_ids: validated.supportingResearchClaimIds,
        p_provenance: { runtime: 'bounded_relation_formation_v1', rationale: validated.rationale },
      })
      if (relation.error) throw relation.error
      if (relation.data?.id) relationIds.push(relation.data.id)

      const target = validated.toItemId === newItem.id ? newItem : candidate.item
      // New evidence should revise an existing belief, not immediately revise the item that just arrived.
      if (target.id !== newItem.id) {
        const revision = computeBeliefRevision({
          relationType: validated.relationType,
          relationConfidence: validated.confidence,
          independentEvidence: validated.evidenceIdentityCount,
          priorConfidence: target.confidence == null ? null : Number(target.confidence),
          targetMateriality: target.materiality == null ? null : Number(target.materiality),
        })
        if (revision) {
          const written = await db.rpc('revise_intelligence_belief_confidence', {
            p_intelligence_item_id: target.id,
            p_revised_confidence: revision.revisedConfidence,
            p_rationale: validated.rationale,
            p_evidence_claim_ids: validated.supportingResearchClaimIds,
            p_evidence_role: revision.role,
            p_provenance: { runtime: 'bounded_relation_formation_v1', relation_type: validated.relationType, relation_id: relation.data?.id ?? null },
          })
          if (written.error) throw written.error
          if (written.data?.id) revisionIds.push(written.data.id)
        }
      }
    } catch {
      rejected += 1
    }
  }

  return { candidateCount: candidates.length, relationIds: [...new Set(relationIds)], revisionIds: [...new Set(revisionIds)], rejected }
}
