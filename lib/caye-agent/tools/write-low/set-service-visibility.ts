import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import { resolveServiceByName } from '../_catalog-helpers'

interface SetServiceVisibilityInput {
  service_name: string
  visibility: 'public' | 'private'
}

export const setServiceVisibility: Tool<SetServiceVisibilityInput> = {
  name: 'set_service_visibility',
  description:
    "Control whether Caye proactively offers a service vs. only quotes it when the guest names " +
    "it. Public = listed in \"what tours do you have?\" answers. Private = honored when named " +
    "directly, never proactively suggested.\n\n" +
    "Use when the owner says \"keep the South Bimini tour quiet\" or \"don't push the private " +
    "charter, but honor it if they ask by name\".",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      service_name: { type: 'string', description: 'Service name as the owner said it.' },
      visibility: {
        type: 'string',
        enum: ['public', 'private'],
        description: 'public = surface proactively; private = only when named by guest.',
      },
    },
    required: ['service_name', 'visibility'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const lookup = await resolveServiceByName(supabase, ctx.workspaceId, args.service_name)
    if (!lookup.ok) return lookup

    const { error } = await supabase
      .from('booking_services')
      .update({ visibility: args.visibility })
      .eq('id', lookup.service.id)
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        service: lookup.service.name,
        visibility: args.visibility,
      },
    }
  },
}
