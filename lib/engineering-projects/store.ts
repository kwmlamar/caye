import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { compareMetrics } from './comparison'

export type EngineeringProjectStatus = 'planning'|'selected'|'executing'|'measuring'|'completed'|'abandoned'
export type EngineeringProjectVerdict = 'succeeded'|'partially_succeeded'|'failed'|'inconclusive'

async function requireProject(workspaceId: string, projectId: string) {
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('engineering_projects').select('id,property_id,status').eq('workspace_id', workspaceId).eq('id', projectId).maybeSingle()
  if (error) throw new Error('Could not verify engineering project scope')
  if (!data) throw new Error('Engineering project not found in this workspace')
  return data
}

async function requirePropertyObservation(workspaceId: string, propertyId: string, observationId: string) {
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('property_observations').select('id,observation_key,numeric_value,text_value,unit,provenance_status,observed_at').eq('workspace_id', workspaceId).eq('property_id', propertyId).eq('id', observationId).maybeSingle()
  if (error) throw new Error('Could not verify property observation scope')
  if (!data) throw new Error('Property observation is not part of this project property')
  return data
}

export async function createEngineeringProject(input: { workspaceId: string; propertyId: string; structureId?: string|null; systemId?: string|null; assetId?: string|null; name: string; objective: string; problemStatement?: string|null; priority?: 'low'|'medium'|'high'|'urgent'; successCriteria?: string[] }) {
  const supabase = createServiceClient()
  const { data: property, error: propertyError } = await supabase.from('physical_properties').select('id').eq('workspace_id', input.workspaceId).eq('id', input.propertyId).maybeSingle()
  if (propertyError || !property) throw new Error('Property not found in this workspace')
  const { data, error } = await supabase.from('engineering_projects').insert({ workspace_id: input.workspaceId, property_id: input.propertyId, structure_id: input.structureId ?? null, system_id: input.systemId ?? null, asset_id: input.assetId ?? null, name: input.name.trim(), objective: input.objective.trim(), problem_statement: input.problemStatement?.trim() || null, priority: input.priority ?? 'medium', success_criteria: input.successCriteria ?? [] }).select('id,name,objective,status,priority,property_id,success_criteria,created_at').single()
  if (error || !data) throw new Error('Could not create engineering project')
  return data
}

export async function listEngineeringProjects(workspaceId: string, propertyId?: string) {
  const supabase = createServiceClient()
  let query = supabase.from('engineering_projects').select('id,property_id,name,objective,status,priority,updated_at').eq('workspace_id', workspaceId).neq('status','abandoned').order('updated_at', { ascending: false })
  if (propertyId) query = query.eq('property_id', propertyId)
  const { data, error } = await query
  if (error) throw new Error('Could not list engineering projects')
  return data ?? []
}

export async function establishEngineeringBaseline(input: { workspaceId: string; projectId: string; observationIds: string[]; notes?: string|null }) {
  const project = await requireProject(input.workspaceId, input.projectId)
  if (project.status === 'executing' || project.status === 'measuring' || project.status === 'completed') throw new Error('Project baseline is frozen once execution begins')
  if (input.observationIds.length === 0) throw new Error('Baseline requires at least one explicit property observation')
  const uniqueIds = [...new Set(input.observationIds)]
  for (const observationId of uniqueIds) await requirePropertyObservation(input.workspaceId, project.property_id, observationId)
  const supabase = createServiceClient()
  const { data: latest } = await supabase.from('engineering_project_baselines').select('revision').eq('workspace_id', input.workspaceId).eq('project_id', input.projectId).order('revision', { ascending: false }).limit(1).maybeSingle()
  const revision = (latest?.revision ?? 0) + 1
  const { data: baseline, error } = await supabase.from('engineering_project_baselines').insert({ workspace_id: input.workspaceId, project_id: input.projectId, revision, status: 'draft', notes: input.notes ?? null }).select('id,revision,status').single()
  if (error || !baseline) throw new Error('Could not create engineering baseline')
  const { error: itemsError } = await supabase.from('engineering_project_baseline_items').insert(uniqueIds.map((property_observation_id) => ({ workspace_id: input.workspaceId, baseline_id: baseline.id, property_observation_id })))
  if (itemsError) throw new Error('Could not attach baseline observations')
  const frozenAt = new Date().toISOString()
  const { data: frozen, error: freezeError } = await supabase.from('engineering_project_baselines').update({ status: 'frozen', frozen_at: frozenAt }).eq('workspace_id', input.workspaceId).eq('id', baseline.id).eq('status','draft').select('id,revision,status,frozen_at').single()
  if (freezeError || !frozen) throw new Error('Could not freeze engineering baseline')
  return frozen
}

export async function addEngineeringAlternative(input: { workspaceId: string; projectId: string; alternativeKey: string; title: string; description: string; assumptions?: string[]; dependencies?: string[]; estimatedCost?: number; costCurrency?: string; predictions?: Array<{ metricKey: string; numericValue: number; unit: string; provenanceStatus: 'operator_confirmed'|'inferred'|'estimated'; confidence?: number|null; rationale?: string|null; analysisRef?: string|null; artifactRef?: string|null }> }) {
  await requireProject(input.workspaceId, input.projectId)
  const supabase = createServiceClient()
  const { data: latest } = await supabase.from('engineering_project_alternatives').select('revision,id').eq('workspace_id', input.workspaceId).eq('project_id', input.projectId).eq('alternative_key', input.alternativeKey).order('revision', { ascending: false }).limit(1).maybeSingle()
  const revision = (latest?.revision ?? 0) + 1
  if (latest?.id) await supabase.from('engineering_project_alternatives').update({ status: 'superseded' }).eq('workspace_id', input.workspaceId).eq('id', latest.id).eq('status','candidate')
  const { data: alternative, error } = await supabase.from('engineering_project_alternatives').insert({ workspace_id: input.workspaceId, project_id: input.projectId, alternative_key: input.alternativeKey.trim(), revision, title: input.title.trim(), description: input.description.trim(), assumptions: input.assumptions ?? [], dependencies: input.dependencies ?? [], estimated_cost: input.estimatedCost ?? null, cost_currency: input.estimatedCost === undefined ? null : input.costCurrency ?? 'USD' }).select('id,alternative_key,revision,title,status,estimated_cost,cost_currency').single()
  if (error || !alternative) throw new Error('Could not create engineering alternative')
  if (input.predictions?.length) {
    const { error: predictionError } = await supabase.from('engineering_project_predictions').insert(input.predictions.map((p) => ({ workspace_id: input.workspaceId, project_id: input.projectId, alternative_id: alternative.id, metric_key: p.metricKey.trim(), numeric_value: p.numericValue, unit: p.unit.trim(), provenance_status: p.provenanceStatus, confidence: p.confidence ?? null, rationale: p.rationale ?? null, analysis_ref: p.analysisRef ?? null, artifact_ref: p.artifactRef ?? null })))
    if (predictionError) throw new Error('Could not record engineering predictions')
  }
  return alternative
}

export async function selectEngineeringAlternative(input: { workspaceId: string; projectId: string; alternativeId: string; sourceMessageId: string; rationale?: string|null }) {
  const project = await requireProject(input.workspaceId, input.projectId)
  if (project.status === 'executing' || project.status === 'measuring' || project.status === 'completed') throw new Error('Cannot change selected intervention after execution begins')
  const supabase = createServiceClient()
  const { data: alt, error } = await supabase.from('engineering_project_alternatives').select('id').eq('workspace_id', input.workspaceId).eq('project_id', input.projectId).eq('id', input.alternativeId).maybeSingle()
  if (error || !alt) throw new Error('Alternative is not part of this project')
  const now = new Date().toISOString()
  await supabase.from('engineering_project_decisions').update({ superseded_at: now }).eq('workspace_id', input.workspaceId).eq('project_id', input.projectId).is('superseded_at', null)
  await supabase.from('engineering_project_alternatives').update({ status: 'superseded' }).eq('workspace_id', input.workspaceId).eq('project_id', input.projectId).eq('status','selected')
  const { data: decision, error: decisionError } = await supabase.from('engineering_project_decisions').insert({ workspace_id: input.workspaceId, project_id: input.projectId, alternative_id: input.alternativeId, source_message_id: input.sourceMessageId, rationale: input.rationale ?? null }).select('id,alternative_id,selected_at').single()
  if (decisionError || !decision) throw new Error('Could not record engineering decision')
  await Promise.all([
    supabase.from('engineering_project_alternatives').update({ status: 'selected' }).eq('workspace_id', input.workspaceId).eq('id', input.alternativeId),
    supabase.from('engineering_projects').update({ status: 'selected', updated_at: now }).eq('workspace_id', input.workspaceId).eq('id', input.projectId),
  ])
  return decision
}

export async function recordEngineeringExecutionEvidence(input: { workspaceId: string; projectId: string; alternativeId?: string|null; sourceMessageId: string; sourceArtifactId?: string|null; installedAssetId?: string|null; evidenceType: 'operator_confirmation'|'artifact'|'installed_asset'; notes?: string|null; occurredAt: string }) {
  await requireProject(input.workspaceId, input.projectId)
  const supabase = createServiceClient()
  const { data: sourceMessage, error: sourceError } = await supabase.from('caye_operator_messages').select('id').eq('workspace_id', input.workspaceId).eq('id', input.sourceMessageId).eq('direction','inbound').eq('origin','dashboard').maybeSingle()
  if (sourceError || !sourceMessage) throw new Error('Execution evidence requires the current human founder message')
  const { data, error } = await supabase.from('engineering_project_execution_evidence').insert({ workspace_id: input.workspaceId, project_id: input.projectId, alternative_id: input.alternativeId ?? null, source_message_id: input.sourceMessageId, source_artifact_id: input.sourceArtifactId ?? null, installed_asset_id: input.installedAssetId ?? null, evidence_type: input.evidenceType, notes: input.notes ?? null, occurred_at: input.occurredAt }).select('id,evidence_type,occurred_at').single()
  if (error || !data) throw new Error('Could not record execution evidence')
  await supabase.from('engineering_projects').update({ status: 'executing', updated_at: new Date().toISOString() }).eq('workspace_id', input.workspaceId).eq('id', input.projectId)
  return data
}

export async function linkEngineeringOutcome(input: { workspaceId: string; projectId: string; metricKey: string; propertyObservationId: string }) {
  const project = await requireProject(input.workspaceId, input.projectId)
  const observation = await requirePropertyObservation(input.workspaceId, project.property_id, input.propertyObservationId)
  if (typeof observation.numeric_value !== 'number' || !observation.unit) throw new Error('Outcome comparison requires a numeric property observation with a unit')
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('engineering_project_outcomes').insert({ workspace_id: input.workspaceId, project_id: input.projectId, metric_key: input.metricKey.trim(), property_observation_id: input.propertyObservationId }).select('id,metric_key,property_observation_id').single()
  if (error || !data) throw new Error('Could not link project outcome')
  await supabase.from('engineering_projects').update({ status: 'measuring', updated_at: new Date().toISOString() }).eq('workspace_id', input.workspaceId).eq('id', input.projectId)
  return data
}

export async function compareEngineeringProjectOutcomes(workspaceId: string, projectId: string) {
  await requireProject(workspaceId, projectId)
  const supabase = createServiceClient()
  const { data: decision } = await supabase.from('engineering_project_decisions').select('alternative_id').eq('workspace_id', workspaceId).eq('project_id', projectId).is('superseded_at', null).maybeSingle()
  if (!decision) return { comparisons: [], missingActual: [], incompatible: [], note: 'No intervention has been selected.' }
  const [{ data: predictions, error: predictionError }, { data: outcomes, error: outcomeError }] = await Promise.all([
    supabase.from('engineering_project_predictions').select('metric_key,numeric_value,unit').eq('workspace_id', workspaceId).eq('project_id', projectId).eq('alternative_id', decision.alternative_id),
    supabase.from('engineering_project_outcomes').select('metric_key,property_observation_id').eq('workspace_id', workspaceId).eq('project_id', projectId),
  ])
  if (predictionError || outcomeError) throw new Error('Could not load project comparison data')
  const actual: Array<{ metricKey: string; numericValue: number; unit: string }> = []
  for (const outcome of outcomes ?? []) {
    const { data: observation } = await supabase.from('property_observations').select('numeric_value,unit').eq('workspace_id', workspaceId).eq('id', outcome.property_observation_id).maybeSingle()
    if (observation && typeof observation.numeric_value === 'number' && observation.unit) actual.push({ metricKey: outcome.metric_key, numericValue: observation.numeric_value, unit: observation.unit })
  }
  return compareMetrics((predictions ?? []).map((p) => ({ metricKey: p.metric_key, numericValue: Number(p.numeric_value), unit: p.unit })), actual)
}

export async function recordEngineeringVerdict(input: { workspaceId: string; projectId: string; verdict: EngineeringProjectVerdict; reasonCodes?: string[]; summary: string; sourceMessageId: string }) {
  await requireProject(input.workspaceId, input.projectId)
  const supabase = createServiceClient()
  const { data: sourceMessage, error: sourceError } = await supabase.from('caye_operator_messages').select('id').eq('workspace_id', input.workspaceId).eq('id', input.sourceMessageId).eq('direction','inbound').eq('origin','dashboard').maybeSingle()
  if (sourceError || !sourceMessage) throw new Error('Project verdict requires the current human founder message')
  const { count, error: outcomeError } = await supabase.from('engineering_project_outcomes').select('id', { count: 'exact', head: true }).eq('workspace_id', input.workspaceId).eq('project_id', input.projectId)
  if (outcomeError) throw new Error('Could not verify project outcome evidence')
  if ((count ?? 0) === 0 && input.verdict !== 'inconclusive') throw new Error('A conclusive project verdict requires at least one linked outcome observation')
  const now = new Date().toISOString()
  await supabase.from('engineering_project_verdicts').update({ superseded_at: now }).eq('workspace_id', input.workspaceId).eq('project_id', input.projectId).is('superseded_at', null)
  const { data, error } = await supabase.from('engineering_project_verdicts').insert({ workspace_id: input.workspaceId, project_id: input.projectId, verdict: input.verdict, reason_codes: [...new Set(input.reasonCodes ?? [])], summary: input.summary.trim(), source_message_id: input.sourceMessageId }).select('id,verdict,reason_codes,summary,created_at').single()
  if (error || !data) throw new Error('Could not record engineering project verdict')
  await supabase.from('engineering_projects').update({ status: input.verdict === 'inconclusive' ? 'measuring' : 'completed', updated_at: now }).eq('workspace_id', input.workspaceId).eq('id', input.projectId)
  return data
}

export async function getEngineeringProjectSnapshot(workspaceId: string, projectId: string) {
  const project = await requireProject(workspaceId, projectId)
  const supabase = createServiceClient()
  const [projectResult, baselineResult, alternativesResult, predictionsResult, decisionResult, executionResult, outcomesResult, verdictResult, learnedOutcomesResult] = await Promise.all([
    supabase.from('engineering_projects').select('*').eq('workspace_id', workspaceId).eq('id', projectId).single(),
    supabase.from('engineering_project_baselines').select('id,revision,status,notes,frozen_at,created_at').eq('workspace_id', workspaceId).eq('project_id', projectId).order('revision', { ascending: false }),
    supabase.from('engineering_project_alternatives').select('*').eq('workspace_id', workspaceId).eq('project_id', projectId).order('created_at'),
    supabase.from('engineering_project_predictions').select('*').eq('workspace_id', workspaceId).eq('project_id', projectId).order('created_at'),
    supabase.from('engineering_project_decisions').select('*').eq('workspace_id', workspaceId).eq('project_id', projectId).order('selected_at', { ascending: false }),
    supabase.from('engineering_project_execution_evidence').select('*').eq('workspace_id', workspaceId).eq('project_id', projectId).order('occurred_at', { ascending: false }),
    supabase.from('engineering_project_outcomes').select('id,metric_key,property_observation_id,created_at').eq('workspace_id', workspaceId).eq('project_id', projectId).order('created_at'),
    supabase.from('engineering_project_verdicts').select('*').eq('workspace_id', workspaceId).eq('project_id', projectId).order('created_at', { ascending: false }),
    supabase.rpc('retrieve_engineering_outcome_memory', { p_workspace_id: workspaceId, p_property_id: project.property_id, p_limit: 20 }),
  ])
  if (projectResult.error || baselineResult.error || alternativesResult.error || predictionsResult.error || decisionResult.error || executionResult.error || outcomesResult.error || verdictResult.error) throw new Error('Engineering project snapshot is incomplete')
  const baselineItems: Array<{ baseline_id: string; observation_ids: string[] }> = []
  for (const baseline of baselineResult.data ?? []) {
    const { data: items, error } = await supabase.from('engineering_project_baseline_items').select('property_observation_id').eq('workspace_id', workspaceId).eq('baseline_id', baseline.id)
    if (error) throw new Error('Engineering project baseline is incomplete')
    baselineItems.push({ baseline_id: baseline.id, observation_ids: (items ?? []).map((i) => i.property_observation_id) })
  }
  const comparison = await compareEngineeringProjectOutcomes(workspaceId, projectId)
  return {
    project: projectResult.data,
    property_id: project.property_id,
    baselines: baselineResult.data ?? [],
    baseline_items: baselineItems,
    alternatives: alternativesResult.data ?? [],
    predictions: predictionsResult.data ?? [],
    decisions: decisionResult.data ?? [],
    execution_evidence: executionResult.data ?? [],
    outcomes: outcomesResult.data ?? [],
    verdicts: verdictResult.data ?? [],
    learned_outcomes: learnedOutcomesResult.error ? [] : learnedOutcomesResult.data ?? [],
    learning_status: learnedOutcomesResult.error ? 'unavailable' : 'available',
    comparison,
  }
}
