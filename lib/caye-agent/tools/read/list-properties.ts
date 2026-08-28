import 'server-only'
import type { Tool } from '../types'
import { listProperties } from '@/lib/property/store'

export const listPropertiesTool: Tool<Record<string, never>> = {
  name: 'list_properties',
  description: 'List physical properties Caye knows in the current workspace. Property records are persistent physical-world context, not permission to change anything.',
  risk: 'read',
  roles: ['founder'],
  modes: ['back-office'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    try {
      const properties = await listProperties(ctx.workspaceId)
      return { ok: true, data: { properties } }
    } catch {
      return { ok: false, error: 'Could not list properties.' }
    }
  },
}
