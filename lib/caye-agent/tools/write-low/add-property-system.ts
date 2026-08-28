import 'server-only'
import type { Tool } from '../types'
import { addPropertySystem } from '@/lib/property/store'

type Input = { property_id: string; name: string; system_type: 'water'|'thermal'|'hvac'|'energy'|'electrical'|'network'|'security'|'wastewater'|'structural'|'other'; status?: 'active'|'inactive'|'unknown'|'needs_attention'; notes?: string }

export const addPropertySystemTool: Tool<Input> = {
  name: 'add_property_system',
  description: 'Add a persistent physical system to a known property, such as water, HVAC, energy, network, or security. Records what exists; does not authorize changes.',
  risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { property_id: { type: 'string' }, name: { type: 'string' }, system_type: { type: 'string', enum: ['water','thermal','hvac','energy','electrical','network','security','wastewater','structural','other'] }, status: { type: 'string', enum: ['active','inactive','unknown','needs_attention'] }, notes: { type: 'string' } }, required: ['property_id','name','system_type'], additionalProperties: false },
  async execute(args, ctx) {
    try {
      const system = await addPropertySystem({ workspaceId: ctx.workspaceId, propertyId: args.property_id, name: args.name, systemType: args.system_type, status: args.status, metadata: args.notes ? { notes: args.notes } : {} })
      return { ok: true, data: { system } }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Could not add property system.' } }
  },
}
