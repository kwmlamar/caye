import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { EpistemicType, IntelligenceScope, assertIntelligenceScope, intelligenceSemanticKey, normalizeIntelligenceStatement } from './identity'

export type IntelligenceEvidence = { claimId: string; role?: 'supports'|'contradicts'|'context' }
export type IntelligenceFinding = {
  scope: IntelligenceScope
  domain: string
  topic: string
  claim: string
  epistemicType: EpistemicType
  confidence?: number | null
  relevance?: number
  novelty?: number
  materiality?: number
  observedAt?: string
  validFrom?: string
  validUntil?: string | null
  refreshAfter?: string | null
  evidence?: IntelligenceEvidence[]
  provenance?: Record<string, unknown>
}

const EVIDENCE_BACKED = new Set<EpistemicType>(['observed_source_fact','source_claim','corroborated_claim'])

export function validateIntelligenceFinding(input: IntelligenceFinding): void {
  assertIntelligenceScope(input.scope)
  if (!input.domain.trim() || !input.topic.trim() || !input.claim.trim()) throw new Error('domain, topic, and claim are required')
  const supportCount = (input.evidence ?? []).filter((e) => (e.role ?? 'supports') === 'supports').length
  if (EVIDENCE_BACKED.has(input.epistemicType) && supportCount === 0) {
    throw new Error(`${input.epistemicType} requires supporting evidence`)
  }
}

function score(value: number | undefined): number { return Math.max(0, Math.min(1, value ?? 0)) }

/**
 * Canonical durable ingestion boundary for all future research desks.
 * Evidence-backed items are initially inserted as unknown, their evidence edges
 * are persisted, and only then are they promoted to the requested epistemic type.
 * This preserves the database evidence guard across Supabase's per-request
 * transactions instead of asking a deferred trigger to span multiple requests.
 */
export async function ingestIntelligenceFinding(input: IntelligenceFinding) {
  validateIntelligenceFinding(input)
  const db = createServiceClient()
  const semanticKey = intelligenceSemanticKey({domain:input.domain,topic:input.topic,claim:input.claim})
  const workspaceId = input.scope.kind === 'workspace' ? input.scope.workspaceId : null
  const scope = input.scope.kind

  let existingQuery = db.from('intelligence_items').select('*')
    .eq('scope',scope).eq('domain',input.domain).eq('semantic_key',semanticKey)
  existingQuery = workspaceId == null ? existingQuery.is('workspace_id', null) : existingQuery.eq('workspace_id', workspaceId)
  const existing = await existingQuery.maybeSingle()
  if (existing.error) throw existing.error

  let item = existing.data
  const requestedEvidenceBackedType = EVIDENCE_BACKED.has(input.epistemicType) ? input.epistemicType : null
  if (!item) {
    const created = await db.from('intelligence_items').insert({
      workspace_id:workspaceId, scope, domain:input.domain, topic:input.topic,
      canonical_claim:input.claim.trim(), semantic_key:semanticKey,
      epistemic_type:requestedEvidenceBackedType ? 'unknown' : input.epistemicType,
      confidence:input.confidence ?? null, relevance:score(input.relevance), novelty:score(input.novelty), materiality:score(input.materiality),
      observed_at:input.observedAt ?? new Date().toISOString(), valid_from:input.validFrom ?? new Date().toISOString(),
      valid_until:input.validUntil ?? null, refresh_after:input.refreshAfter ?? null, provenance:input.provenance ?? {},
    }).select('*').single()
    if (created.error) throw created.error
    item = created.data
  } else {
    // Repetition strengthens evidence, not ontology. Preserve the original epistemic boundary.
    const updated = await db.from('intelligence_items').update({
      confidence: input.confidence == null ? item.confidence : Math.max(Number(item.confidence ?? 0), input.confidence),
      relevance: Math.max(Number(item.relevance ?? 0), score(input.relevance)),
      materiality: Math.max(Number(item.materiality ?? 0), score(input.materiality)),
      observed_at: input.observedAt ?? new Date().toISOString(), updated_at:new Date().toISOString(),
    }).eq('id',item.id).select('*').single()
    if (updated.error) throw updated.error
    item = updated.data
  }

  for (const evidence of input.evidence ?? []) {
    const edge = await db.from('intelligence_item_claims').upsert({
      intelligence_item_id:item.id, claim_id:evidence.claimId, role:evidence.role ?? 'supports',
    },{onConflict:'intelligence_item_id,claim_id,role'})
    if (edge.error) throw edge.error
  }

  if (!existing.data && requestedEvidenceBackedType) {
    const promoted = await db.from('intelligence_items').update({
      epistemic_type: requestedEvidenceBackedType,
      updated_at: new Date().toISOString(),
    }).eq('id', item.id).select('*').single()
    if (promoted.error) throw promoted.error
    item = promoted.data
  }

  return { item, semanticKey, deduplicated:Boolean(existing.data) }
}

export async function relateIntelligence(input:{fromItemId:string;toItemId:string;relationType:'related'|'corroborates'|'contradicts'|'supersedes'|'causes'|'implicates';confidence?:number;provenance?:Record<string,unknown>}) {
  if (input.fromItemId === input.toItemId) throw new Error('intelligence item cannot relate to itself')
  const db=createServiceClient()
  const {data,error}=await db.from('intelligence_relations').upsert({from_item_id:input.fromItemId,to_item_id:input.toItemId,relation_type:input.relationType,confidence:input.confidence??null,provenance:input.provenance??{}},{onConflict:'from_item_id,to_item_id,relation_type'}).select('*').single()
  if(error) throw error
  return data
}

export async function supersedeIntelligence(oldItemId:string,newItemId:string,provenance:Record<string,unknown>={}) {
  const db=createServiceClient()
  const relation=await relateIntelligence({fromItemId:newItemId,toItemId:oldItemId,relationType:'supersedes',provenance})
  const {error}=await db.from('intelligence_items').update({status:'superseded',superseded_by:newItemId,valid_until:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',oldItemId).neq('id',newItemId)
  if(error) throw error
  return relation
}

export { normalizeIntelligenceStatement }
