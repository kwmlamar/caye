import 'server-only'
import type { Tool } from '@/lib/caye-agent/tools/types'
import {
  addEngineeringAlternative,
  compareEngineeringProjectOutcomes,
  createEngineeringProject,
  establishEngineeringBaseline,
  getEngineeringProjectSnapshot,
  linkEngineeringOutcome,
  listEngineeringProjects,
  recordEngineeringExecutionEvidence,
  recordEngineeringVerdict,
  selectEngineeringAlternative,
} from './store'
import { getEngineeringOutcomeLearningGuidance, processEngineeringOutcomeLearning } from './outcome-learning'

function directOnly(ctx: { channel?: 'dashboard' }) {
  return ctx.channel === 'dashboard' ? null : { ok: false as const, error: 'Engineering project intelligence is available only in founder Caye Direct.' }
}

export const listEngineeringProjectsTool: Tool<{ property_id?: string }> = {
  name: 'list_engineering_projects', description: 'List persistent engineering/experiment projects in the current workspace, optionally for one property. Projects describe intended change and evidence; they never authorize physical action.', risk: 'read', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { property_id: { type: 'string' } }, additionalProperties: false },
  async execute(args, ctx) { const blocked = directOnly(ctx); if (blocked) return blocked; try { return { ok: true, data: await listEngineeringProjects(ctx.workspaceId, args.property_id) } } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not list projects.' } } },
}

export const getEngineeringProjectTool: Tool<{ project_id: string }> = {
  name: 'get_engineering_project', description: 'Load one persistent engineering project with baseline, alternatives, predictions, selection, execution evidence, outcomes, verdicts, and deterministic comparison. Use this before continuing a known physical project in a fresh Direct conversation.', risk: 'read', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'], additionalProperties: false },
  async execute(args, ctx) { const blocked = directOnly(ctx); if (blocked) return blocked; try { return { ok: true, data: await getEngineeringProjectSnapshot(ctx.workspaceId, args.project_id) } } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not load project.' } } },
}

export const createEngineeringProjectTool: Tool<{ property_id: string; name: string; objective: string; problem_statement?: string; priority?: 'low'|'medium'|'high'|'urgent'; success_criteria?: string[] }> = {
  name: 'create_engineering_project', description: 'Create a persistent founder engineering project linked to a property. Records an objective and success criteria only; does not authorize purchasing, contractors, device control, or physical work.', risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { property_id: { type: 'string' }, name: { type: 'string' }, objective: { type: 'string' }, problem_statement: { type: 'string' }, priority: { type: 'string', enum: ['low','medium','high','urgent'] }, success_criteria: { type: 'array', items: { type: 'string' } } }, required: ['property_id','name','objective'], additionalProperties: false },
  async execute(args, ctx) { const blocked = directOnly(ctx); if (blocked) return blocked; try { const project = await createEngineeringProject({ workspaceId: ctx.workspaceId, propertyId: args.property_id, name: args.name, objective: args.objective, problemStatement: args.problem_statement, priority: args.priority, successCriteria: args.success_criteria }); return { ok: true, data: { project, note: 'Project created; no physical action was performed.' } } } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not create project.' } } },
}

export const establishEngineeringBaselineTool: Tool<{ project_id: string; property_observation_ids: string[]; notes?: string }> = {
  name: 'establish_engineering_baseline', description: 'Freeze an immutable baseline for a project from explicit existing property-observation IDs. Never invent or copy baseline numbers from prose; get the property snapshot first and reference the observations that actually support the baseline.', risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, property_observation_ids: { type: 'array', items: { type: 'string' }, minItems: 1 }, notes: { type: 'string' } }, required: ['project_id','property_observation_ids'], additionalProperties: false },
  async execute(args, ctx) { const blocked = directOnly(ctx); if (blocked) return blocked; try { return { ok: true, data: await establishEngineeringBaseline({ workspaceId: ctx.workspaceId, projectId: args.project_id, observationIds: args.property_observation_ids, notes: args.notes }) } } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not establish baseline.' } } },
}

export const addEngineeringAlternativeTool: Tool<{ project_id: string; alternative_key: string; title: string; description: string; assumptions?: string[]; dependencies?: string[]; estimated_cost?: number; cost_currency?: string; predictions?: Array<{ metric_key: string; numeric_value: number; unit: string; provenance_status: 'operator_confirmed'|'inferred'|'estimated'; confidence?: number; rationale?: string; analysis_ref?: string; artifact_ref?: string }> }> = {
  name: 'add_engineering_alternative', description: 'Add or revise a candidate engineering intervention with explicit assumptions, dependencies, cost estimate, and predicted metrics. Predictions remain predictions and a candidate is not authorization or a safety proof. Validated outcome-learning may be returned as non-authoritative guidance for inferred/estimated predictions.', risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, alternative_key: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, assumptions: { type: 'array', items: { type: 'string' } }, dependencies: { type: 'array', items: { type: 'string' } }, estimated_cost: { type: 'number' }, cost_currency: { type: 'string' }, predictions: { type: 'array', items: { type: 'object', properties: { metric_key: { type: 'string' }, numeric_value: { type: 'number' }, unit: { type: 'string' }, provenance_status: { type: 'string', enum: ['operator_confirmed','inferred','estimated'] }, confidence: { type: 'number' }, rationale: { type: 'string' }, analysis_ref: { type: 'string' }, artifact_ref: { type: 'string' } }, required: ['metric_key','numeric_value','unit','provenance_status'], additionalProperties: false } } }, required: ['project_id','alternative_key','title','description'], additionalProperties: false },
  async execute(args, ctx) {
    const blocked = directOnly(ctx); if (blocked) return blocked
    try {
      const mappedPredictions = args.predictions?.map((p) => ({ metricKey: p.metric_key, numericValue: p.numeric_value, unit: p.unit, provenanceStatus: p.provenance_status, confidence: p.confidence, rationale: p.rationale, analysisRef: p.analysis_ref, artifactRef: p.artifact_ref }))
      const learningGuidance = mappedPredictions?.length ? await getEngineeringOutcomeLearningGuidance(ctx.workspaceId, mappedPredictions.map((p) => ({ metricKey: p.metricKey, unit: p.unit, provenanceStatus: p.provenanceStatus }))) : []
      const alternative = await addEngineeringAlternative({ workspaceId: ctx.workspaceId, projectId: args.project_id, alternativeKey: args.alternative_key, title: args.title, description: args.description, assumptions: args.assumptions, dependencies: args.dependencies, estimatedCost: args.estimated_cost, costCurrency: args.cost_currency, predictions: mappedPredictions })
      return { ok: true, data: { alternative, learning_guidance: learningGuidance, learning_note: learningGuidance.length ? 'Validated historical outcome learning is advisory and does not override founder-confirmed inputs.' : undefined } }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not add alternative.' } }
  },
}

export const selectEngineeringAlternativeTool: Tool<{ project_id: string; alternative_id: string; rationale?: string }> = {
  name: 'select_engineering_alternative', description: 'Record the founder selection of a candidate intervention. Selection is an auditable decision, not authorization to physically execute it and not proof of safety.', risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, alternative_id: { type: 'string' }, rationale: { type: 'string' } }, required: ['project_id','alternative_id'], additionalProperties: false },
  async execute(args, ctx) { const blocked = directOnly(ctx); if (blocked) return blocked; if (!ctx.engineeringOrigin?.messageId) return { ok: false, error: 'Founder source message is required for an engineering decision.' }; try { return { ok: true, data: await selectEngineeringAlternative({ workspaceId: ctx.workspaceId, projectId: args.project_id, alternativeId: args.alternative_id, sourceMessageId: ctx.engineeringOrigin.messageId, rationale: args.rationale }) } } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not select alternative.' } } },
}

export const recordEngineeringExecutionTool: Tool<{ project_id: string; alternative_id?: string; evidence_type: 'operator_confirmation'|'artifact'|'installed_asset'; source_artifact_id?: string; installed_asset_id?: string; notes?: string; occurred_at: string }> = {
  name: 'record_engineering_execution', description: 'Record human/external evidence that physical work actually occurred. This may only bind to the current inbound founder Direct message; the model cannot manufacture an execution event from its own text. It does not itself perform any physical action.', risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, alternative_id: { type: 'string' }, evidence_type: { type: 'string', enum: ['operator_confirmation','artifact','installed_asset'] }, source_artifact_id: { type: 'string' }, installed_asset_id: { type: 'string' }, notes: { type: 'string' }, occurred_at: { type: 'string' } }, required: ['project_id','evidence_type','occurred_at'], additionalProperties: false },
  async execute(args, ctx) { const blocked = directOnly(ctx); if (blocked) return blocked; if (!ctx.engineeringOrigin?.messageId) return { ok: false, error: 'Execution evidence requires a current founder Direct source message.' }; try { return { ok: true, data: await recordEngineeringExecutionEvidence({ workspaceId: ctx.workspaceId, projectId: args.project_id, alternativeId: args.alternative_id, sourceMessageId: ctx.engineeringOrigin.messageId, sourceArtifactId: args.source_artifact_id, installedAssetId: args.installed_asset_id, evidenceType: args.evidence_type, notes: args.notes, occurredAt: args.occurred_at }) } } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not record execution evidence.' } } },
}

export const linkEngineeringOutcomeTool: Tool<{ project_id: string; metric_key: string; property_observation_id: string }> = {
  name: 'link_engineering_outcome', description: 'Link a post-intervention metric to an existing numeric property observation. Outcome truth stays in Property Intelligence with its original provenance; this project only references it.', risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, metric_key: { type: 'string' }, property_observation_id: { type: 'string' } }, required: ['project_id','metric_key','property_observation_id'], additionalProperties: false },
  async execute(args, ctx) { const blocked = directOnly(ctx); if (blocked) return blocked; try { return { ok: true, data: await linkEngineeringOutcome({ workspaceId: ctx.workspaceId, projectId: args.project_id, metricKey: args.metric_key, propertyObservationId: args.property_observation_id }) } } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not link outcome.' } } },
}

export const compareEngineeringProjectOutcomesTool: Tool<{ project_id: string }> = {
  name: 'compare_engineering_project_outcomes', description: 'Deterministically compare the selected intervention predictions with linked numeric property observations. Refuses incompatible units rather than asking the model to improvise conversions.', risk: 'read', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'], additionalProperties: false },
  async execute(args, ctx) { const blocked = directOnly(ctx); if (blocked) return blocked; try { return { ok: true, data: await compareEngineeringProjectOutcomes(ctx.workspaceId, args.project_id) } } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not compare outcomes.' } } },
}

export const recordEngineeringVerdictTool: Tool<{ project_id: string; verdict: 'succeeded'|'partially_succeeded'|'failed'|'inconclusive'; reason_codes?: string[]; summary: string }> = {
  name: 'record_engineering_verdict', description: 'Record a founder-grounded project verdict. Succeeded/partial/failed require linked outcome evidence; with insufficient outcome evidence use inconclusive. A conclusive verdict triggers evidence-gated candidate learning; inferred lessons remain quarantined until repeated verified outcomes validate them.', risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, verdict: { type: 'string', enum: ['succeeded','partially_succeeded','failed','inconclusive'] }, reason_codes: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } }, required: ['project_id','verdict','summary'], additionalProperties: false },
  async execute(args, ctx) {
    const blocked = directOnly(ctx); if (blocked) return blocked
    if (!ctx.engineeringOrigin?.messageId) return { ok: false, error: 'Project verdict requires the current founder Direct source message.' }
    try {
      const verdict = await recordEngineeringVerdict({ workspaceId: ctx.workspaceId, projectId: args.project_id, verdict: args.verdict, reasonCodes: args.reason_codes, summary: args.summary, sourceMessageId: ctx.engineeringOrigin.messageId })
      const learning = await processEngineeringOutcomeLearning({ workspaceId: ctx.workspaceId, projectId: args.project_id, verdictId: verdict.id, verdict: args.verdict, sourceMessageId: ctx.engineeringOrigin.messageId })
      return { ok: true, data: { verdict, learning } }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not record verdict.' } }
  },
}
