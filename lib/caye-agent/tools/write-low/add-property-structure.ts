import 'server-only'
import type { Tool } from '../types'
import { addPropertyStructure } from '@/lib/property/store'

type Input = {
  property_id: string
  name: string
  structure_type?: 'building' | 'shed' | 'tank_pad' | 'utility' | 'other'
  notes?: string
}

export const addPropertyStructureTool: Tool<Input> = {
  name: 'add_property_structure',
  description: 'Add a persistent structure/building within a known physical property from founder Caye Direct. Records what exists; does not authorize construction or physical changes.',
  risk: 'low',
  roles: ['founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      property_id: { type: 'string' },
      name: { type: 'string' },
      structure_type: { type: 'string', enum: ['building','shed','tank_pad','utility','other'] },
      notes: { type: 'string' },
    },
    required: ['property_id','name'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (ctx.channel !== 'dashboard') return { ok: false, error: 'Property records can only be changed from founder Caye Direct.' }
    try {
      const structure = await addPropertyStructure({
        workspaceId: ctx.workspaceId,
        propertyId: args.property_id,
        name: args.name,
        structureType: args.structure_type,
        metadata: args.notes ? { notes: args.notes } : {},
      })
      return { ok: true, data: { structure } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not add property structure.' }
    }
  },
}
