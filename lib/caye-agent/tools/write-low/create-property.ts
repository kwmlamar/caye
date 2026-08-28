import 'server-only'
import type { Tool } from '../types'
import { createProperty } from '@/lib/property/store'

type Input = { name: string; property_type?: 'residential'|'commercial'|'mixed'|'land'|'other'; location_label?: string; notes?: string }

export const createPropertyTool: Tool<Input> = {
  name: 'create_property',
  description: 'Create a persistent physical-property record in the current workspace. This records a place Caye should understand over time; it does not authorize any physical work or device control.',
  risk: 'low',
  roles: ['founder'],
  modes: ['back-office'],
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, property_type: { type: 'string', enum: ['residential','commercial','mixed','land','other'] }, location_label: { type: 'string' }, notes: { type: 'string' } }, required: ['name'], additionalProperties: false },
  async execute(args, ctx) {
    try {
      const property = await createProperty({ workspaceId: ctx.workspaceId, name: args.name, propertyType: args.property_type, locationLabel: args.location_label ?? null, metadata: args.notes ? { notes: args.notes } : {} })
      return { ok: true, data: { property, note: 'Property record created. No physical action was performed.' } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not create property.' }
    }
  },
}
