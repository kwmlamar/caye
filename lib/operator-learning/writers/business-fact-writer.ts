import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { findConflictingFact } from '@/lib/business-fact-conflict'
import { findSemanticFactMatch } from '@/lib/business-fact-semantic-match'
import { canonicalPropertyKey, canSupersede, type LearningAuthority } from '@/lib/business-learning/model'
import { resolveGroundedService } from '../service-grounding'
import { CLASSIFIER_VERSION, type ClassificationResult } from '../schema'
import type { WriteOutcome } from './types'

function legacyAuthority(row: { authority_kind?: string | null; memory_type?: string | null; source: string; knowledge_mode?: string | null }): LearningAuthority {
  if (row.memory_type === 'correction' && ['owner', 'founder'].includes(row.authority_kind ?? '')) return 'owner_correction'
  if (['owner', 'founder', 'operator'].includes(row.authority_kind ?? '') || ['owner-direct', 'escalation-capture', 'operator-learning'].includes(row.source)) return 'owner_instruction'
  if (['onboarding', 'configured', 'business-profile'].includes(row.source)) return 'configured_business_source'
  if (['email', 'gmail', 'whatsapp', 'customer-communication', 'continuous-learning'].includes(row.source)) return 'direct_business_communication'
  if (row.knowledge_mode === 'observed') return 'repeated_operational_observation'
  if (['inferred', 'derived'].includes(row.knowledge_mode ?? '')) return 'inferred_pattern'
  return 'speculative_extraction'
}

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

  // The model proposes a topic label, but identity is finalized here. Value
  // words are stripped and wording aliases collapse to a stable PROPERTY key.
  // "Casino Tram Stop" is a value; meeting_point is the property.
  let effectiveCanonicalKey = canonicalPropertyKey({
    suggestedProperty: classifierCanonicalKey,
    valueText: payload.text,
    scope: {
      target: args.classification.scope.target === 'service' ? 'service' : 'workspace',
      serviceName,
    },
    resolvedServiceId: serviceId,
  })

  const { data: existingRows, error: existingErr } = await supabase
    .from('business_facts')
    .select('id, fact, source, expires_at, canonical_key, service_id, authority_kind, memory_type, knowledge_mode, valid_from, created_at')
    .eq('workspace_id', args.workspaceId)
    .is('superseded_at', null)
  if (existingErr) return { decision: 'error', reason: `active-fact lookup failed: ${existingErr.message}` }
  const now = Date.now()
  const active = (existingRows ?? []).filter((r) => !r.expires_at || new Date(r.expires_at as string).getTime() > now) as Array<{
    id: string; fact: string; source: string; expires_at: string | null; canonical_key: string | null; service_id: string | null
    authority_kind: string | null; memory_type: string | null; knowledge_mode: string | null; valid_from: string | null; created_at: string
  }>

  const isCorrection = args.classification.explicitness === 'explicit_correction'
  const incomingAuthority: LearningAuthority = isCorrection ? 'owner_correction' : 'owner_instruction'
  const canonicalCurrent = active.find((r) => r.canonical_key === effectiveCanonicalKey)

  // Canonical identity wins over semantic guessing. If the same property has a
  // different current value, that is a conflict by construction.
  let conflictingRow = canonicalCurrent && canonicalCurrent.fact.trim() !== payload.text.trim() ? canonicalCurrent : undefined
  let conflictResolution: 'supersede' | 'ambiguous' | null = conflictingRow ? 'supersede' : null

  // Legacy/null-key and cross-scope rows still need semantic reconciliation so
  // old deployments remain correct while canonical identity rolls forward.
  if (!conflictingRow) {
    const scopedServiceIds = Array.from(new Set(active.map((r) => r.service_id).filter((id): id is string => !!id)))
    const scopeNameById = new Map<string, string>()
    if (scopedServiceIds.length > 0) {
      const { data: scopedServices } = await supabase.from('booking_services').select('id, name').in('id', scopedServiceIds)
      for (const s of (scopedServices ?? []) as { id: string; name: string }[]) scopeNameById.set(s.id, s.name)
    }
    const scopeLabelFor = (r: { service_id: string | null }): string | undefined => r.service_id ? `specific to ${scopeNameById.get(r.service_id) ?? 'one service'}` : 'workspace-wide (applies to all services)'
    const newFactScopeLabel = serviceId ? `specific to ${serviceName ?? 'one service'}` : 'workspace-wide (applies to all services)'
    const conflict = await findConflictingFact(
      payload.text,
      active.map((r) => ({ id: r.id, text: r.fact, source: r.source, scopeLabel: scopeLabelFor(r) })),
      { workspaceId: args.workspaceId, source: 'operator-learning/writers/business-fact-writer.ts', newFactScopeLabel }
    )
    if (conflict.checkFailed) return { decision: 'error', reason: 'conflict check against active facts failed — refusing to write unverified' }
    conflictingRow = conflict.conflictId ? active.find((r) => r.id === conflict.conflictId) : undefined
    conflictResolution = conflict.resolution
    if (conflictingRow && conflictResolution === 'ambiguous') {
      return { decision: 'candidate', reason: `may conflict with an existing fact ("${conflictingRow.fact}") without clearly replacing it` }
    }
  }

  // Explicit authority is separate from confidence. A newer observation or
  // repeated lower-authority pattern may become more confident, but it cannot
  // use confidence to overrule explicit owner/configured policy.
  if (conflictingRow && conflictResolution === 'supersede') {
    const currentAuthority = legacyAuthority(conflictingRow)
    if (!canSupersede(
      { authority: incomingAuthority, occurredAt: new Date().toISOString() },
      { authority: currentAuthority, occurredAt: conflictingRow.valid_from ?? conflictingRow.created_at }
    )) {
      return { decision: 'candidate', reason: `incoming ${incomingAuthority} cannot supersede higher-authority ${currentAuthority} memory` }
    }
  }

  const { matchId: semanticMatchId } = await findSemanticFactMatch(
    payload.text,
    active.map((r) => ({ id: r.id, text: r.fact })),
    { workspaceId: args.workspaceId, source: 'operator-learning/writers/business-fact-writer.ts:dedup' }
  )
  const semanticMatchRow = semanticMatchId ? active.find((r) => r.id === semanticMatchId) : undefined

  // A fuzzy same-topic match still names an already-established canonical
  // identity. Unless this write already resolved deterministically to that
  // identity (canonicalCurrent), inherit it rather than minting a fresh,
  // disconnected key for what the matcher says is the same tracked property —
  // otherwise every paraphrase of an existing fact fragments its lineage.
  if (!canonicalCurrent && semanticMatchRow?.canonical_key) {
    effectiveCanonicalKey = semanticMatchRow.canonical_key
  }

  const supersedeId = (conflictingRow && conflictResolution === 'supersede' ? conflictingRow.id : null) ?? (semanticMatchRow ? semanticMatchRow.id : null)

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
    p_provenance: {
      producer: 'operator-learning-router',
      classifier_version: CLASSIFIER_VERSION,
      classifier_canonical_key: classifierCanonicalKey,
      canonical_property_key: effectiveCanonicalKey,
      explicitness: args.classification.explicitness,
      scope_kind: args.classification.scope.kind,
      scope_target: args.classification.scope.target,
      classification_rationale: args.classification.rationale,
      learning_authority: incomingAuthority,
    },
    p_contradicts_fact_id: conflictingRow?.id ?? null,
    p_correction_of_fact_id: isCorrection ? supersedeId : null,
  }).single()

  if (error) return { decision: 'error', reason: `write_typed_business_memory_atomic failed: ${error.message}` }
  const row = rpcResult as { id: string; created_at: string; superseded_id: string | null }
  return {
    decision: row.superseded_id ? 'superseded_and_written' : 'written',
    targetTable: 'business_facts',
    targetRecordId: row.id,
    supersededRecordId: row.superseded_id,
    reason: row.superseded_id
      ? isCorrection
        ? 'superseded same canonical property and persisted typed correction lineage'
        : 'superseded same canonical property and persisted typed memory'
      : 'persisted typed operating memory with no active same-property predecessor',
  }
}
