import 'server-only'
import type { Tool } from '../types'
import { getPropertySnapshot } from '@/lib/property/store'

type Input = { property_id: string }

export const getPropertySnapshotTool: Tool<Input> = {
  name: 'get_property_snapshot',
  description: 'Load the persistent physical-world snapshot for one property, including structures, systems, assets, and recent observations with provenance. In Caye Direct, when a visual systems card helps, include the returned display_block inside the final rich-result blocks array; property_snapshot is a valid semantic block in addition to the generic block types.',
  risk: 'read',
  roles: ['founder'],
  modes: ['back-office'],
  inputSchema: { type: 'object', properties: { property_id: { type: 'string' } }, required: ['property_id'], additionalProperties: false },
  async execute(args, ctx) {
    try {
      const snapshot = await getPropertySnapshot(ctx.workspaceId, args.property_id)
      if (!snapshot) return { ok: false, error: 'Property not found in this workspace.' }
      return {
        ok: true,
        data: {
          ...snapshot,
          display_block: { type: 'property_snapshot', propertyId: snapshot.property.id },
        },
      }
    } catch {
      return { ok: false, error: 'Could not load that property.' }
    }
  },
}
