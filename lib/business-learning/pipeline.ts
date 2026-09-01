import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { evaluateObservationEligibility, type LearningObservationInput } from './filter'
import { extractBusinessLearning } from './extract'
import {
  authorityRank,
  canSupersede,
  canonicalPropertyKey,
  normalizedCandidateValue,
  promotionPolicy,
  type ExtractedLearningCandidate,
  type LearningAuthority,
} from './model'

const JOB_NAME = 'continuous-business-learning'
const CAPABILITY = 'business_memory_learning'

type Supabase = ReturnType<typeof createServiceClient>
type EventType =
  | 'observation_examined' | 'observation_excluded' | 'extraction_started' | 'extraction_failed'
  | 'candidate_created' | 'candidate_deduplicated' | 'candidate_rejected' | 'fact_promoted'
  | 'fact_updated' | 'conflict_detected' | 'conflict_resolved' | 'fact_superseded'

interface ObservationRow {
  id: string
  workspace_id: string
  source_kind: string
  source_id: string
  source_fingerprint: string
  source_channel: string | null
  conversation_id: string | null
  unified_message_id: string | null
  operator_message_id: string | null
  content: string
  source_metadata: Record<string, unknown> | null
  semantic_scope: string | null
  status: string
  attempt_count: number
  created_at: string
}

function authorityFor(row: ObservationRow): LearningAuthority {
  if (row.source_kind === 'owner_correction') return 'owner_correction'
  if (row.source_kind === 'owner_instruction') return 'owner_instruction'
  if (row.source_kind === 'operator_message') {
    const text = row.content.toLowerCase()
    const correction = /\b(no[, ]|actually|instead|changed|moved|not anymore|from now on|correction|wrong)\b/.test(text)
    return correction ? 'owner_correction' : 'owner_instruction'
  }
  const source = String(row.source_metadata?.source ?? row.source_channel ?? '').toLowerCase()
  if (/onboarding|business[_ -]?profile|configured/.test(source)) return 'configured_business_source'
  return 'direct_business_communication'
}

function existingAuthority(row: { authority_kind: string | null; memory_type: string | null; source: string; knowledge_mode: string | null }): LearningAuthority {
  if (row.memory_type === 'correction' && ['owner','founder'].includes(row.authority_kind ?? '')) return 'owner_correction'
  if (['owner','founder','operator'].includes(row.authority_kind ?? '') || ['owner-direct','escalation-capture','operator-learning'].includes(row.source)) return 'owner_instruction'
  if (['onboarding','configured','business-profile'].includes(row.source)) return 'configured_business_source'
  if (['email','gmail','whatsapp','customer-communication','continuous-learning'].includes(row.source)) return 'direct_business_communication'
  if (row.knowledge_mode === 'observed') return 'repeated_operational_observation'
  if (['inferred','derived'].includes(row.knowledge_mode ?? '')) return 'inferred_pattern'
  return 'speculative_extraction'
}

async function event(
  supabase: Supabase,
  row: ObservationRow,
  eventType: EventType,
  refs: { candidateId?: string | null; factId?: string | null; details?: Record<string, unknown> } = {}
): Promise<void> {
  const { error } = await supabase.from('business_learning_events').insert({
    workspace_id: row.workspace_id,
    event_type: eventType,
    observation_id: row.id,
    candidate_id: refs.candidateId ?? null,
    fact_id: refs.factId ?? null,
    source_kind: row.source_kind,
    source_id: row.source_id,
    job_name: JOB_NAME,
    capability: CAPABILITY,
    details: refs.details ?? {},
  })
  if (error) console.error('[business-learning] event write failed:', eventType, error.message)
}

async function markObservation(supabase: Supabase, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('business_learning_observations').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) console.error('[business-learning] observation state write failed:', error.message)
}

async function resolveServiceId(supabase: Supabase, workspaceId: string, candidate: ExtractedLearningCandidate): Promise<string | null> {
  if (candidate.scope.target !== 'service' || !candidate.scope.serviceName) return null
  const { data } = await supabase
    .from('booking_services')
    .select('id, name')
    .eq('workspace_id', workspaceId)
    .ilike('name', candidate.scope.serviceName)
    .limit(1)
    .maybeSingle()
  return data?.id ? String(data.id) : null
}

async function persistCandidate(args: {
  supabase: Supabase
  row: ObservationRow
  extracted: ExtractedLearningCandidate
  authority: LearningAuthority
  canonicalKey: string
}): Promise<{ id: string; occurrenceCount: number; created: boolean }> {
  const { supabase, row, extracted, authority, canonicalKey } = args
  const normalized = normalizedCandidateValue(extracted.valueText)
  // Candidate identity is property + normalized value. Observation identity is
  // independently unique in business_learning_observations, so replaying one
  // source cannot inflate occurrence_count while independent repetitions can.
  const fingerprint = `${row.workspace_id}|${canonicalKey}|${normalized}`
  const { data: existing } = await supabase
    .from('business_fact_candidates')
    .select('id, occurrence_count, conversation_ids, provenance, confidence, authority_kind')
    .eq('workspace_id', row.workspace_id)
    .eq('candidate_fingerprint', fingerprint)
    .maybeSingle()

  if (existing) {
    const provenance = (existing.provenance ?? {}) as Record<string, unknown>
    const observationIds = Array.isArray(provenance.observation_ids) ? provenance.observation_ids.map(String) : []
    if (observationIds.includes(row.id)) {
      await event(supabase, row, 'candidate_deduplicated', { candidateId: existing.id, details: { canonical_key: canonicalKey, reason: 'same observation replay' } })
      return { id: existing.id, occurrenceCount: existing.occurrence_count, created: false }
    }
    const conversationIds = Array.isArray(existing.conversation_ids) ? existing.conversation_ids.map(String) : []
    const nextConversationIds = row.conversation_id && !conversationIds.includes(row.conversation_id) ? [...conversationIds, row.conversation_id] : conversationIds
    const oldAuthority = (existing.authority_kind as LearningAuthority | null) ?? 'speculative_extraction'
    const strongestAuthority = authorityRank(authority) > authorityRank(oldAuthority) ? authority : oldAuthority
    const nextCount = Number(existing.occurrence_count ?? 1) + 1
    await supabase.from('business_fact_candidates').update({
      occurrence_count: nextCount,
      conversation_ids: nextConversationIds,
      last_seen_at: new Date().toISOString(),
      confidence: Math.max(Number(existing.confidence ?? 0), extracted.confidence),
      authority_kind: strongestAuthority,
      provenance: { ...provenance, observation_ids: [...observationIds, row.id] },
    }).eq('id', existing.id)
    await event(supabase, row, 'candidate_deduplicated', { candidateId: existing.id, details: { canonical_key: canonicalKey, reason: 'same property/value evidence merged', occurrence_count: nextCount } })
    return { id: existing.id, occurrenceCount: nextCount, created: false }
  }

  const conversationIds = row.conversation_id ? [row.conversation_id] : []
  const { data: inserted, error } = await supabase.from('business_fact_candidates').insert({
    workspace_id: row.workspace_id,
    normalized_text: normalized,
    sample_text: extracted.valueText,
    category_guess: extracted.category,
    conversation_ids: conversationIds,
    occurrence_count: 1,
    status: 'pending',
    source: 'continuous-learning',
    observation_id: row.id,
    canonical_key: canonicalKey,
    candidate_fingerprint: fingerprint,
    memory_type: extracted.kind,
    authority_kind: authority,
    confidence: extracted.confidence,
    customer_use_state: extracted.customerUseState,
    valid_from: row.created_at,
    source_kind: row.source_kind,
    source_id: row.source_id,
    provenance: {
      observation_ids: [row.id],
      source_fingerprint: row.source_fingerprint,
      source_channel: row.source_channel,
      extractor: 'continuous-business-learning.v1',
      rationale: extracted.rationale,
      consequential: extracted.consequential,
    },
  }).select('id').single()
  if (error || !inserted) throw new Error(`candidate insert failed: ${error?.message ?? 'missing row'}`)
  await event(supabase, row, 'candidate_created', { candidateId: inserted.id, details: { canonical_key: canonicalKey, authority, customer_use_state: extracted.customerUseState } })
  return { id: String(inserted.id), occurrenceCount: 1, created: true }
}

async function maybePromote(args: {
  supabase: Supabase
  row: ObservationRow
  extracted: ExtractedLearningCandidate
  authority: LearningAuthority
  canonicalKey: string
  candidateId: string
  occurrenceCount: number
  serviceId: string | null
}): Promise<void> {
  const { supabase, row, extracted, authority, canonicalKey, candidateId, occurrenceCount, serviceId } = args
  const policy = promotionPolicy({ authority, confidence: extracted.confidence, occurrenceCount, consequential: extracted.consequential, customerUseState: extracted.customerUseState })
  if (!policy.promote) return

  const { data: activeRows, error: activeErr } = await supabase
    .from('business_facts')
    .select('id, fact, canonical_key, authority_kind, memory_type, source, knowledge_mode, valid_from, created_at')
    .eq('workspace_id', row.workspace_id)
    .eq('canonical_key', canonicalKey)
    .is('superseded_at', null)
  if (activeErr) throw new Error(`active fact lookup failed: ${activeErr.message}`)

  const sameValue = (activeRows ?? []).find((f) => normalizedCandidateValue(f.fact) === normalizedCandidateValue(extracted.valueText))
  if (sameValue) {
    await supabase.from('business_fact_candidates').update({ status: 'resolved', outcome: 'duplicate_fact', outcome_at: new Date().toISOString(), resolved_fact_id: sameValue.id }).eq('id', candidateId)
    await event(supabase, row, 'candidate_deduplicated', { candidateId, factId: sameValue.id, details: { canonical_key: canonicalKey, reason: 'current fact already has same value' } })
    return
  }

  const current = (activeRows ?? [])[0] as undefined | { id: string; fact: string; authority_kind: string | null; memory_type: string | null; source: string; knowledge_mode: string | null; valid_from: string | null; created_at: string }
  let supersedeId: string | null = null
  if (current) {
    await event(supabase, row, 'conflict_detected', { candidateId, factId: current.id, details: { canonical_key: canonicalKey, existing_value: current.fact, incoming_value: extracted.valueText } })
    const oldAuthority = existingAuthority(current)
    const incomingWins = canSupersede(
      { authority, occurredAt: row.created_at },
      { authority: oldAuthority, occurredAt: current.valid_from ?? current.created_at }
    )
    if (!incomingWins) {
      // Keep evidence as a candidate, but never let repetition manufacture the
      // authority needed to overturn explicit business policy.
      await event(supabase, row, 'candidate_rejected', { candidateId, factId: current.id, details: { reason: 'lower-authority evidence cannot supersede current fact', incoming_authority: authority, current_authority: oldAuthority } })
      return
    }
    supersedeId = current.id
  }

  const memoryType = authority === 'owner_correction' ? 'correction' : extracted.kind === 'policy' ? 'policy' : extracted.kind === 'procedure' ? 'procedure' : 'fact'
  const knowledgeMode = authorityRank(authority) >= authorityRank('configured_business_source') ? 'explicit' : authority === 'repeated_operational_observation' ? 'observed' : 'inferred'
  const authorityKind = authority === 'owner_correction' || authority === 'owner_instruction' ? 'owner' : authority === 'configured_business_source' ? 'configured' : 'observation'
  const { data: rpc, error } = await supabase.rpc('write_typed_business_memory_atomic', {
    p_workspace_id: row.workspace_id,
    p_category: extracted.category,
    p_fact: extracted.valueText,
    p_source: 'continuous-learning',
    p_created_by: authorityKind,
    p_service_id: serviceId,
    p_canonical_key: canonicalKey,
    p_expires_at: null,
    p_supersede_id: supersedeId,
    p_memory_type: memoryType,
    p_subject_type: serviceId ? 'service' : 'workspace',
    p_subject_id: serviceId,
    p_knowledge_mode: knowledgeMode,
    p_confidence: extracted.confidence,
    p_valid_from: row.created_at,
    p_sensitivity: 'workspace',
    p_authority_kind: authorityKind,
    p_provenance: {
      producer: JOB_NAME,
      observation_id: row.id,
      source_kind: row.source_kind,
      source_id: row.source_id,
      source_fingerprint: row.source_fingerprint,
      candidate_id: candidateId,
      learning_authority: authority,
      customer_use_state: extracted.customerUseState,
    },
    p_contradicts_fact_id: supersedeId,
    p_correction_of_fact_id: authority === 'owner_correction' ? supersedeId : null,
  }).single()
  if (error || !rpc) throw new Error(`fact promotion failed: ${error?.message ?? 'missing rpc result'}`)
  const result = rpc as { id: string; superseded_id: string | null }
  await supabase.from('business_facts').update({ customer_use_state: extracted.customerUseState }).eq('id', result.id)
  await supabase.from('business_fact_candidates').update({ status: 'resolved', outcome: 'promoted', outcome_at: new Date().toISOString(), resolved_fact_id: result.id }).eq('id', candidateId)
  await event(supabase, row, supersedeId ? 'fact_updated' : 'fact_promoted', { candidateId, factId: result.id, details: { canonical_key: canonicalKey, authority, policy_reason: policy.reason } })
  if (supersedeId) {
    await event(supabase, row, 'fact_superseded', { candidateId, factId: supersedeId, details: { superseded_by: result.id, canonical_key: canonicalKey } })
    await event(supabase, row, 'conflict_resolved', { candidateId, factId: result.id, details: { superseded_fact_id: supersedeId, canonical_key: canonicalKey } })
  }
}

export async function processBusinessLearningObservation(observationId: string): Promise<void> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('business_learning_observations').select('*').eq('id', observationId).maybeSingle()
  if (error || !data) throw new Error(`learning observation not found: ${error?.message ?? observationId}`)
  const row = data as ObservationRow
  if (row.status === 'processed' || row.status === 'excluded') return

  await markObservation(supabase, row.id, { status: 'processing', processing_started_at: new Date().toISOString(), attempt_count: Number(row.attempt_count ?? 0) + 1, processing_error: null })
  await event(supabase, row, 'observation_examined')

  const input: LearningObservationInput = {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceFingerprint: row.source_fingerprint,
    sourceChannel: row.source_channel,
    content: row.content,
    sourceMetadata: row.source_metadata ?? {},
    semanticScope: row.semantic_scope,
  }
  const eligibility = evaluateObservationEligibility(input)
  if (!eligibility.eligible) {
    await markObservation(supabase, row.id, { status: 'excluded', exclusion_reason: eligibility.reason, processed_at: new Date().toISOString() })
    await event(supabase, row, 'observation_excluded', { details: { reason: eligibility.reason } })
    return
  }

  const authority = authorityFor(row)
  await event(supabase, row, 'extraction_started', { details: { authority } })
  const extracted = await extractBusinessLearning({ workspaceId: row.workspace_id, content: row.content, sourceKind: row.source_kind, sourceChannel: row.source_channel, authority, sourceMetadata: row.source_metadata ?? {} })
  if (!extracted.ok) {
    await markObservation(supabase, row.id, { status: 'failed', processing_error: extracted.reason })
    await event(supabase, row, 'extraction_failed', { details: { error: extracted.reason } })
    return
  }

  for (const candidate of extracted.candidates) {
    if (!candidate.durable || ['temporary_state','customer_state'].includes(candidate.kind)) {
      await event(supabase, row, 'candidate_rejected', { details: { kind: candidate.kind, reason: 'not durable business memory', rationale: candidate.rationale } })
      continue
    }
    const serviceId = await resolveServiceId(supabase, row.workspace_id, candidate)
    if (candidate.scope.target === 'service' && !serviceId) {
      await event(supabase, row, 'candidate_rejected', { details: { reason: 'service scope could not be grounded', service_name: candidate.scope.serviceName } })
      continue
    }
    const canonicalKey = canonicalPropertyKey({ suggestedProperty: candidate.propertyKey, valueText: candidate.valueText, scope: candidate.scope, resolvedServiceId: serviceId })
    const persisted = await persistCandidate({ supabase, row, extracted: candidate, authority, canonicalKey })
    await maybePromote({ supabase, row, extracted: candidate, authority, canonicalKey, candidateId: persisted.id, occurrenceCount: persisted.occurrenceCount, serviceId })
  }

  await markObservation(supabase, row.id, { status: 'processed', processed_at: new Date().toISOString(), processing_error: null })
}

export async function processPendingBusinessLearning(limit = 25): Promise<{ processed: number; failed: number }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('business_learning_observations')
    .select('id')
    .in('status', ['pending','failed'])
    .order('created_at', { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)))
  if (error) throw new Error(`learning queue read failed: ${error.message}`)
  let processed = 0
  let failed = 0
  for (const item of data ?? []) {
    try {
      await processBusinessLearningObservation(String(item.id))
      processed++
    } catch (err) {
      failed++
      console.error('[business-learning] observation processing failed:', item.id, err)
    }
  }
  return { processed, failed }
}
