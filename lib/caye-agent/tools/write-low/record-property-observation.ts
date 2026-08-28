import 'server-only'
import type { Tool } from '../types'
import { recordPropertyObservation, type PropertyObservationProvenance } from '@/lib/property/store'

type ModelWritableProvenance = Exclude<PropertyObservationProvenance, 'measured'>

type Input = {
  property_id: string
  structure_id?: string
  system_id?: string
  asset_id?: string
  key: string
  numeric_value?: number
  text_value?: string
  unit?: string
  provenance_status: ModelWritableProvenance
  confidence?: number
  source_artifact_id?: string
  notes?: string
}

export const recordPropertyObservationTool: Tool<Input> = {
  name: 'record_property_observation',
  description: 'Persist one physical-world observation from founder Caye Direct with explicit provenance. Use observed for a directly visible fact, operator_confirmed when the founder/operator states the value (including a measurement they report), and inferred/estimated for derived or planning assumptions. The measured provenance class is intentionally reserved for future deterministic sensor/measurement ingestion and cannot be selected by the model. Numeric values require a unit.',
  risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { property_id: { type: 'string' }, structure_id: { type: 'string' }, system_id: { type: 'string' }, asset_id: { type: 'string' }, key: { type: 'string' }, numeric_value: { type: 'number' }, text_value: { type: 'string' }, unit: { type: 'string' }, provenance_status: { type: 'string', enum: ['observed','operator_confirmed','inferred','estimated'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, source_artifact_id: { type: 'string' }, notes: { type: 'string' } }, required: ['property_id','key','provenance_status'], additionalProperties: false },
  async execute(args, ctx) {
    if (ctx.channel !== 'dashboard') return { ok: false, error: 'Property records can only be changed from founder Caye Direct.' }
    try {
      const observation = await recordPropertyObservation({ workspaceId: ctx.workspaceId, propertyId: args.property_id, structureId: args.structure_id ?? null, systemId: args.system_id ?? null, assetId: args.asset_id ?? null, key: args.key, numericValue: args.numeric_value, textValue: args.text_value, unit: args.unit, provenanceStatus: args.provenance_status, confidence: args.confidence ?? null, sourceArtifactId: args.source_artifact_id ?? null, sourceMessageId: ctx.engineeringOrigin?.messageId ?? null, notes: args.notes ?? null })
      return { ok: true, data: { observation } }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Could not record property observation.' } }
  },
}
