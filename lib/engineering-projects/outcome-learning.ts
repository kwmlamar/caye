import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export const ENGINEERING_OUTCOME_LEARNING_VERSION = 'engineering-outcome-v1'
export const ENGINEERING_OUTCOME_MIN_PROJECTS = 2
export const ENGINEERING_OUTCOME_MIN_ABS_ERROR_PERCENT = 20

export type CalibrationDirection = 'underpredicted' | 'overpredicted'

export interface EngineeringLearningGuidance {
  metricKey: string
  unit: string
  direction: CalibrationDirection
  confidence: number
  evidenceCount: number
  memoryId: string
  recommendation: string
}

export function classifyCalibration(predicted: number, actual: number): { direction: CalibrationDirection | null; percentError: number | null } {
  if (!Number.isFinite(predicted) || !Number.isFinite(actual)) return { direction: null, percentError: null }
  if (predicted === 0) return { direction: null, percentError: null }
  const percentError = ((actual - predicted) / Math.abs(predicted)) * 100
  if (Math.abs(percentError) < ENGINEERING_OUTCOME_MIN_ABS_ERROR_PERCENT) return { direction: null, percentError }
  return { direction: percentError > 0 ? 'underpredicted' : 'overpredicted', percentError }
}

export function calibrationCanonicalKey(metricKey: string, unit: string) {
  return `engineering_prediction_calibration:${metricKey.trim().toLowerCase()}:${unit.trim().toLowerCase()}`
}

export function calibrationCandidateKey(metricKey: string, unit: string, direction: CalibrationDirection) {
  return `${calibrationCanonicalKey(metricKey, unit)}:${direction}`
}

export function recommendationForCalibration(metricKey: string, unit: string, direction: CalibrationDirection, evidenceCount: number) {
  const bias = direction === 'underpredicted' ? 'below' : 'above'
  return `Verified outcomes across ${evidenceCount} engineering projects show inferred/estimated ${metricKey} predictions have tended to land ${bias} actual results. Treat a new ${metricKey} ${unit} estimate as calibration guidance, not policy, and seek stronger analysis or measurement before relying on it.`
}

async function writeAudit(input: {
  workspaceId: string
  sourceMessageId: string
  sourceExcerpt: string
  canonicalKey: string
  decision: 'candidate' | 'validated' | 'rejected' | 'superseded' | 'no_op'
  targetTable?: string
  targetRecordId?: string | null
  supersededRecordId?: string | null
  reason: string
}) {
  const supabase = createServiceClient()
  const { error } = await supabase.from('operator_learning_audit').insert({
    workspace_id: input.workspaceId,
    source_message_id: input.sourceMessageId,
    source_excerpt: input.sourceExcerpt.slice(0, 1000),
    classifier_version: ENGINEERING_OUTCOME_LEARNING_VERSION,
    explicitness: 'inferred',
    scope_kind: 'workspace',
    risk_level: 'low',
    destination: input.targetTable === 'business_facts' ? 'business_fact' : 'business_fact_candidate',
    canonical_key: input.canonicalKey,
    decision: input.decision,
    target_table: input.targetTable ?? null,
    target_record_id: input.targetRecordId ?? null,
    superseded_record_id: input.supersededRecordId ?? null,
    reason: input.reason,
  })
  if (error) throw new Error('Could not persist operator learning audit history')
}

async function publishAdaptiveLearningRuntimeEvidence(workspaceId: string, guidanceCount: number) {
  if (guidanceCount < 1) return
  const supabase = createServiceClient()
  const { data: capability, error: capabilityError } = await supabase
    .from('caye_operating_intelligence_capabilities')
    .select('id')
    .eq('capability_key', 'adaptive_learning')
    .maybeSingle()
  if (capabilityError || !capability) {
    console.warn('[engineering-outcome-learning] adaptive_learning Direction capability unavailable:', capabilityError?.message ?? 'missing capability')
    return
  }
  const observedAt = new Date().toISOString()
  const { error } = await supabase.from('caye_operating_intelligence_capability_evidence').upsert({
    capability_id: capability.id,
    evidence_kind: 'runtime',
    source_ref: `engineering_outcome_learning_guidance:${workspaceId}`,
    summary: `A validated, outcome-backed engineering lesson was retrieved and surfaced into a later engineering decision context (${guidanceCount} guidance item${guidanceCount === 1 ? '' : 's'}).`,
    verifies_capability: true,
    confidence: 1,
    observed_at: observedAt,
    verified_at: observedAt,
  }, { onConflict: 'capability_id,evidence_kind,source_ref' })
  if (error) console.warn('[engineering-outcome-learning] Direction evidence write failed:', error.message)
}

export async function processEngineeringOutcomeLearning(input: {
  workspaceId: string
  projectId: string
  verdictId: string
  verdict: 'succeeded' | 'partially_succeeded' | 'failed' | 'inconclusive'
  sourceMessageId: string
}) {
  if (input.verdict === 'inconclusive') return { candidates: 0, validated: 0, skipped: 'inconclusive_verdict' as const }
  const supabase = createServiceClient()

  const [{ data: decision, error: decisionError }, { count: executionCount, error: executionError }] = await Promise.all([
    supabase.from('engineering_project_decisions').select('alternative_id').eq('workspace_id', input.workspaceId).eq('project_id', input.projectId).is('superseded_at', null).maybeSingle(),
    supabase.from('engineering_project_execution_evidence').select('id', { count: 'exact', head: true }).eq('workspace_id', input.workspaceId).eq('project_id', input.projectId),
  ])
  if (decisionError || executionError || !decision || (executionCount ?? 0) < 1) {
    await writeAudit({ workspaceId: input.workspaceId, sourceMessageId: input.sourceMessageId, sourceExcerpt: `Engineering verdict ${input.verdictId}`, canonicalKey: `engineering_project:${input.projectId}`, decision: 'rejected', reason: 'Outcome learning requires a selected intervention plus verified execution evidence.' })
    return { candidates: 0, validated: 0, skipped: 'insufficient_execution_evidence' as const }
  }

  const [{ data: predictions, error: predictionError }, { data: outcomes, error: outcomeError }] = await Promise.all([
    supabase.from('engineering_project_predictions').select('id,metric_key,numeric_value,unit,provenance_status').eq('workspace_id', input.workspaceId).eq('project_id', input.projectId).eq('alternative_id', decision.alternative_id).in('provenance_status', ['inferred', 'estimated']),
    supabase.from('engineering_project_outcomes').select('id,metric_key,property_observation_id').eq('workspace_id', input.workspaceId).eq('project_id', input.projectId),
  ])
  if (predictionError || outcomeError) throw new Error('Could not load engineering outcome-learning evidence')

  let candidateCount = 0
  let validatedCount = 0
  for (const prediction of predictions ?? []) {
    const matchingOutcomes = (outcomes ?? []).filter((o) => o.metric_key === prediction.metric_key)
    for (const outcome of matchingOutcomes) {
      const { data: observation, error: observationError } = await supabase.from('property_observations').select('numeric_value,unit,provenance_status').eq('workspace_id', input.workspaceId).eq('id', outcome.property_observation_id).maybeSingle()
      if (observationError || !observation || typeof observation.numeric_value !== 'number' || !observation.unit) continue
      if (!['measured', 'observed', 'operator_confirmed'].includes(observation.provenance_status)) continue
      if (observation.unit.trim().toLowerCase() !== prediction.unit.trim().toLowerCase()) continue

      const calibration = classifyCalibration(Number(prediction.numeric_value), Number(observation.numeric_value))
      if (!calibration.direction || calibration.percentError == null) continue
      const canonicalKey = calibrationCanonicalKey(prediction.metric_key, prediction.unit)
      const candidateKey = calibrationCandidateKey(prediction.metric_key, prediction.unit, calibration.direction)
      const evidenceRef = { project_id: input.projectId, verdict_id: input.verdictId, prediction_id: prediction.id, outcome_id: outcome.id, percent_error: calibration.percentError }

      const { data: existingCandidate, error: candidateReadError } = await supabase.from('business_fact_candidates').select('id,status,occurrence_count,evidence_refs').eq('workspace_id', input.workspaceId).eq('normalized_text', candidateKey).maybeSingle()
      if (candidateReadError) throw new Error('Could not read engineering outcome-learning candidate')
      if (existingCandidate?.status === 'resolved') {
        await writeAudit({ workspaceId: input.workspaceId, sourceMessageId: input.sourceMessageId, sourceExcerpt: `Engineering verdict ${input.verdictId}`, canonicalKey, decision: 'no_op', targetTable: 'business_fact_candidates', targetRecordId: existingCandidate.id, reason: 'Matching outcome lesson is already validated; later matching evidence does not reopen the resolved candidate.' })
        continue
      }

      const refs = Array.isArray(existingCandidate?.evidence_refs) ? existingCandidate.evidence_refs as Array<Record<string, unknown>> : []
      const alreadyCounted = refs.some((ref) => ref.project_id === input.projectId)
      const nextRefs = alreadyCounted ? refs : [...refs, evidenceRef]
      const distinctProjects = new Set(nextRefs.map((ref) => String(ref.project_id))).size
      const confidence = Math.min(0.9, 0.55 + distinctProjects * 0.15)
      const sampleText = recommendationForCalibration(prediction.metric_key, prediction.unit, calibration.direction, distinctProjects)

      let candidateId = existingCandidate?.id as string | undefined
      if (candidateId) {
        const { error } = await supabase.from('business_fact_candidates').update({
          sample_text: sampleText,
          occurrence_count: distinctProjects,
          last_seen_at: new Date().toISOString(),
          proposed_at: distinctProjects >= ENGINEERING_OUTCOME_MIN_PROJECTS ? new Date().toISOString() : null,
          status: distinctProjects >= ENGINEERING_OUTCOME_MIN_PROJECTS ? 'proposed' : 'pending',
          confidence,
          evidence_refs: nextRefs,
          canonical_key: canonicalKey,
        }).eq('workspace_id', input.workspaceId).eq('id', candidateId)
        if (error) throw new Error('Could not update engineering outcome-learning candidate')
      } else {
        const { data: created, error } = await supabase.from('business_fact_candidates').insert({
          workspace_id: input.workspaceId,
          normalized_text: candidateKey,
          sample_text: sampleText,
          category_guess: 'service_detail',
          conversation_ids: [],
          occurrence_count: 1,
          status: 'pending',
          source: 'outcome_learning',
          confidence,
          evidence_refs: nextRefs,
          canonical_key: canonicalKey,
        }).select('id').single()
        if (error || !created) throw new Error('Could not create engineering outcome-learning candidate')
        candidateId = created.id
      }
      candidateCount += 1

      if (distinctProjects < ENGINEERING_OUTCOME_MIN_PROJECTS) {
        await writeAudit({ workspaceId: input.workspaceId, sourceMessageId: input.sourceMessageId, sourceExcerpt: sampleText, canonicalKey, decision: 'candidate', targetTable: 'business_fact_candidates', targetRecordId: candidateId, reason: `Candidate has ${distinctProjects}/${ENGINEERING_OUTCOME_MIN_PROJECTS} distinct verified projects.` })
        continue
      }

      const { data: activeMemory, error: memoryReadError } = await supabase.from('business_facts').select('id,knowledge_mode,authority_kind,fact').eq('workspace_id', input.workspaceId).eq('canonical_key', canonicalKey).is('superseded_at', null).maybeSingle()
      if (memoryReadError) throw new Error('Could not verify higher-authority operating memory')
      if (activeMemory && ['explicit', 'observed'].includes(activeMemory.knowledge_mode)) {
        await writeAudit({ workspaceId: input.workspaceId, sourceMessageId: input.sourceMessageId, sourceExcerpt: sampleText, canonicalKey, decision: 'rejected', targetTable: 'business_fact_candidates', targetRecordId: candidateId, reason: 'Validated inferred lesson was blocked by higher-authority explicit/observed knowledge.' })
        continue
      }

      const now = new Date()
      const expiresAt = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString()
      const { data: memoryId, error: memoryError } = await supabase.rpc('write_typed_business_memory_atomic', {
        p_workspace_id: input.workspaceId,
        p_category: 'service_detail',
        p_fact: sampleText,
        p_source: 'candidate-confirmed',
        p_created_by: ENGINEERING_OUTCOME_LEARNING_VERSION,
        p_service_id: null,
        p_canonical_key: canonicalKey,
        p_expires_at: expiresAt,
        p_supersede_id: activeMemory?.id ?? null,
        p_memory_type: 'operating_pattern',
        p_subject_type: 'workspace',
        p_subject_id: null,
        p_knowledge_mode: 'inferred',
        p_confidence: confidence,
        p_valid_from: now.toISOString(),
        p_sensitivity: 'workspace',
        p_authority_kind: 'system',
        p_provenance: { source: 'engineering_outcome_learning', version: ENGINEERING_OUTCOME_LEARNING_VERSION, evidence_refs: nextRefs, threshold_projects: ENGINEERING_OUTCOME_MIN_PROJECTS },
        p_contradicts_fact_id: activeMemory?.id ?? null,
        p_correction_of_fact_id: null,
      })
      if (memoryError || !memoryId) throw new Error('Could not persist validated engineering outcome lesson')

      const { error: resolveError } = await supabase.from('business_fact_candidates').update({ status: 'resolved', outcome: 'confirmed', outcome_at: now.toISOString(), resolved_fact_id: memoryId }).eq('workspace_id', input.workspaceId).eq('id', candidateId)
      if (resolveError) throw new Error('Validated lesson was written but candidate resolution could not be recorded')
      await writeAudit({ workspaceId: input.workspaceId, sourceMessageId: input.sourceMessageId, sourceExcerpt: sampleText, canonicalKey, decision: activeMemory ? 'superseded' : 'validated', targetTable: 'business_facts', targetRecordId: String(memoryId), supersededRecordId: activeMemory?.id ?? null, reason: `Validated after ${distinctProjects} distinct projects with trusted outcome provenance and verified execution evidence.` })
      validatedCount += 1
    }
  }

  return { candidates: candidateCount, validated: validatedCount }
}

export async function getEngineeringOutcomeLearningGuidance(workspaceId: string, predictions: Array<{ metricKey: string; unit: string; provenanceStatus: 'operator_confirmed' | 'inferred' | 'estimated' }>): Promise<EngineeringLearningGuidance[]> {
  const eligible = predictions.filter((p) => p.provenanceStatus !== 'operator_confirmed')
  if (eligible.length === 0) return []
  const supabase = createServiceClient()
  const guidance: EngineeringLearningGuidance[] = []
  for (const prediction of eligible) {
    const canonicalKey = calibrationCanonicalKey(prediction.metricKey, prediction.unit)
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('business_facts').select('id,fact,confidence,provenance,knowledge_mode,authority_kind').eq('workspace_id', workspaceId).eq('canonical_key', canonicalKey).eq('memory_type', 'operating_pattern').is('superseded_at', null).lte('valid_from', now).or(`expires_at.is.null,expires_at.gt.${now}`).maybeSingle()
    if (error || !data || data.knowledge_mode !== 'inferred') continue
    const refs = Array.isArray(data.provenance?.evidence_refs) ? data.provenance.evidence_refs : []
    const text = String(data.fact)
    const direction: CalibrationDirection = text.includes('below actual results') ? 'underpredicted' : 'overpredicted'
    guidance.push({ metricKey: prediction.metricKey, unit: prediction.unit, direction, confidence: Number(data.confidence), evidenceCount: new Set(refs.map((r: Record<string, unknown>) => String(r.project_id))).size, memoryId: data.id, recommendation: text })
  }
  await publishAdaptiveLearningRuntimeEvidence(workspaceId, guidance.length)
  return guidance
}
