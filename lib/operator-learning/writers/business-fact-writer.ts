import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { findConflictingFact } from '@/lib/business-fact-conflict'
import { findSemanticFactMatch } from '@/lib/business-fact-semantic-match'
import { resolveGroundedService } from '../service-grounding'
import { CLASSIFIER_VERSION, type ClassificationResult } from '../schema'
import type { WriteOutcome } from './types'

export async function writeBusinessFact(args: {
  workspaceId: string
  callerRole: string
  classification: ClassificationResult
  operatorText: string
}): Promise<WriteOutcome> {
  const payload = args.classification.businessFact
  if (!payload) return { decision: 'error', reason: 'destination business_fact but no businessFact payload' }
  const classifierCanonicalKey = args.classification.canonicalKey
  if (!classifierCanonicalKey) return { decision: 'error', reason: 'missing canonicalKey for a routable classification' }

  const supabase = createServiceClient()
  let serviceId: string | null = null
  let serviceName: string | null = null
  if (args.classification.scope.target === 'service') {
    if (!args.classification.scope.serviceName) {
      return { decision: 'candidate', reason: 'service-scoped knowledge has no service name; refusing to widen it to workspace scope' }
    }
    const lookup = await resolveGroundedService(supabase, args.workspaceId, args.classification.scope.serviceName, args.operatorText)
    if (lookup.ok && lookup.service) {
      serviceId = lookup.service.id
      serviceName = lookup.service.name
    } else {
      return { decision: 'candidate', reason: `content is scoped to a specific service, but "${args.classification.scope.serviceName}" did not resolve: ${lookup.error}` }
    }
  }

  const { data: existingRows, error: existingErr } = await supabase.from('business_facts').select('id, fact, source, expires_at, canonical_key, service_id').eq('workspace_id', args.workspaceId).is('superseded_at', null)
  if (existingErr) return { decision: 'error', reason: `active-fact lookup failed: ${existingErr.message}` }
  const now = Date.now()
  const active = (existingRows ?? []).filter((r) => !r.expires_at || new Date(r.expires_at as string).getTime() > now) as Array<{ id: string; fact: string; source: string; expires_at: string | null; canonical_key: string | null; service_id: string | null }>

  const scopedServiceIds = Array.from(new Set(active.map((r) => r.service_id).filter((id): id is string => !!id)))
  const scopeNameById = new Map<string, string>()
  if (scopedServiceIds.length > 0) {
    const { data: scopedServices } = await supabase.from('booking_services').select('id, name').in('id', scopedServiceIds)
    for (const s of (scopedServices ?? []) as { id: string; name: string }[]) scopeNameById.set(s.id, s.name)
  }
  const scopeLabelFor = (r: { service_id: string | null }): string | undefined => r.service_id ? `specific to ${scopeNameById.get(r.service_id) ?? 'one service'}` : 'workspace-wide (applies to all services)'
  const newFactScopeLabel = serviceId ? `specific to ${serviceName ?? 'one service'}` : 'workspace-wide (applies to all services)'

  const conflict = await findConflictingFact(payload.text, active.map((r) => ({ id: r.id, text: r.fact, source: r.source, scopeLabel: scopeLabelFor(r) })), { workspaceId: args.workspaceId, source: 'operator-learning/writers/business-fact-writer.ts', newFactScopeLabel })
  if (conflict.checkFailed) return { decision: 'error', reason: 'conflict check against active facts failed — refusing to write unverified' }
  const conflictingRow = conflict.conflictId ? active.find((r) => r.id === conflict.conflictId) : undefined
  if (conflictingRow && conflict.resolution === 'ambiguous') return { decision: 'candidate', reason: `may conflict with an existing fact ("${conflictingRow.fact}") without clearly replacing it` }

  const { matchId: semanticMatchId } = await findSemanticFactMatch(payload.text, active.map((r) => ({ id: r.id, text: r.fact })), { workspaceId: args.workspaceId, source: 'operator-learning/writers/business-fact-writer.ts:dedup' })
  const semanticMatchRow = semanticMatchId ? active.find((r) => r.id === semanticMatchId) : undefined
  const supersedeId = (conflictingRow && conflict.resolution === 'supersede' ? conflictingRow.id : null) ?? (semanticMatchRow ? semanticMatchRow.id : null)
  const effectiveCanonicalKey = semanticMatchRow?.canonical_key ?? classifierCanonicalKey

  const isCorrection = args.classification.explicitness === 'explicit_correction'
  const memoryType = isCorrection ? 'correction' : payload.category === 'policy' ? 'policy' : 'fact'
  const knowledgeMode = args.classification.explicitness === 'inferred_from_action' ? 'inferred' : 'explicit'
  const subjectType = serviceId ? 'service' : 'workspace'
  const authorityKind = args.callerRole === 'founder' ? 'founder' : args.callerRole === 'owner' ? 'owner' : 'operator'

  const { data: rpcResult, error } = await supabase.rpc('write_typed_business_memory_atomic', {
    p_workspace_id: args.workspaceId,
    p_category: payload.category,
    p_fact: payload.text,
    p_source: 'operator-learning',
    p_created_by: args.callerRole,
    p_service_id: serviceId,
    p_canonical_key: effectiveCanonicalKey,
    p_expires_at: null,
    p_supersede_id: supersedeId,
    p_memory_type: memoryType,
    p_subject_type: subjectType,
    p_subject_id: serviceId,
    p_knowledge_mode: knowledgeMode,
    p_confidence: args.classification.confidence,
    p_valid_from: new Date().toISOString(),
    p_sensitivity: 'workspace',
    p_authority_kind: authorityKind,
    p_provenance: { producer: 'operator-learning-router', classifier_version: CLASSIFIER_VERSION, explicitness: args.classification.explicitness, scope_kind: args.classification.scope.kind, scope_target: args.classification.scope.target, classification_rationale: args.classification.rationale },
    p_contradicts_fact_id: conflict.conflictId ?? null,
    p_correction_of_fact_id: isCorrection ? supersedeId : null,
  }).single()

  if (error) return { decision: 'error', reason: `write_typed_business_memory_atomic failed: ${error.message}` }
  const row = rpcResult as { id: string; created_at: string; superseded_id: string | null }
  return {
    decision: row.superseded_id ? 'superseded_and_written' : 'written', targetTable: 'business_facts', targetRecordId: row.id, supersededRecordId: row.superseded_id,
    reason: row.superseded_id
      ? semanticMatchRow && !conflictingRow
        ? isCorrection
          ? 'superseded a same-topic active fact and persisted typed correction lineage'
          : 'superseded a same-topic active fact and persisted typed memory'
        : isCorrection
          ? 'superseded conflicting/same-topic memory and persisted typed correction lineage'
          : 'superseded conflicting/same-topic memory and persisted typed memory'
      : 'persisted typed operating memory with no active same-topic predecessor',
  }
}
