import 'server-only'
import type { Tool } from '../types'
import { addPropertyAsset } from '@/lib/property/store'

type Input = { property_id: string; system_id?: string; name: string; asset_type: string; manufacturer?: string; model?: string; status?: 'operational'|'offline'|'unknown'|'needs_attention'|'retired'; specifications?: Record<string, unknown>; notes?: string }

export const addPropertyAssetTool: Tool<Input> = {
  name: 'add_property_asset',
  description: 'Add a physical asset/component to a property, such as a tank, pump, filter, gutter run, AC unit, router, camera, or panel. Specifications must be explicit evidence or clearly labeled assumptions; never invent missing model/spec values.',
  risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { property_id: { type: 'string' }, system_id: { type: 'string' }, name: { type: 'string' }, asset_type: { type: 'string' }, manufacturer: { type: 'string' }, model: { type: 'string' }, status: { type: 'string', enum: ['operational','offline','unknown','needs_attention','retired'] }, specifications: { type: 'object', additionalProperties: true }, notes: { type: 'string' } }, required: ['property_id','name','asset_type'], additionalProperties: false },
  async execute(args, ctx) {
    try {
      const asset = await addPropertyAsset({ workspaceId: ctx.workspaceId, propertyId: args.property_id, systemId: args.system_id ?? null, name: args.name, assetType: args.asset_type, manufacturer: args.manufacturer ?? null, model: args.model ?? null, status: args.status, specifications: args.specifications ?? {}, metadata: args.notes ? { notes: args.notes } : {} })
      ctx.propertySnapshotIds?.push(args.property_id)
      return { ok: true, data: { asset } }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Could not add property asset.' } }
  },
}
