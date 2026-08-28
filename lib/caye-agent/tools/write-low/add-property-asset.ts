import 'server-only'
import type { Tool } from '../types'
import { addPropertyAsset } from '@/lib/property/store'

type Input = {
  property_id: string
  system_id?: string
  structure_id?: string
  name: string
  asset_type: string
  manufacturer?: string
  model?: string
  status?: 'operational'|'offline'|'unknown'|'needs_attention'|'retired'
  notes?: string
}

export const addPropertyAssetTool: Tool<Input> = {
  name: 'add_property_asset',
  description: 'Add the identity of a physical asset/component to a property from founder Caye Direct, such as a tank, pump, filter, gutter run, AC unit, router, camera, or panel. Optionally attach it to a known structure/system in the same property. Do not put capacities, dimensions, ratings, or other quantitative specifications here; record those separately with record_property_observation so provenance and units are explicit.',
  risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { property_id: { type: 'string' }, system_id: { type: 'string' }, structure_id: { type: 'string' }, name: { type: 'string' }, asset_type: { type: 'string' }, manufacturer: { type: 'string' }, model: { type: 'string' }, status: { type: 'string', enum: ['operational','offline','unknown','needs_attention','retired'] }, notes: { type: 'string' } }, required: ['property_id','name','asset_type'], additionalProperties: false },
  async execute(args, ctx) {
    if (ctx.channel !== 'dashboard') return { ok: false, error: 'Property records can only be changed from founder Caye Direct.' }
    try {
      const asset = await addPropertyAsset({ workspaceId: ctx.workspaceId, propertyId: args.property_id, systemId: args.system_id ?? null, structureId: args.structure_id ?? null, name: args.name, assetType: args.asset_type, manufacturer: args.manufacturer ?? null, model: args.model ?? null, status: args.status, specifications: {}, metadata: args.notes ? { notes: args.notes } : {} })
      return { ok: true, data: { asset } }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Could not add property asset.' } }
  },
}
