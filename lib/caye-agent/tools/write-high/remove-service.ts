import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import { resolveServiceByName } from '../_catalog-helpers'
import { HIGH_RISK_CONFIRMATION_PREAMBLE } from './_booking-helpers'

interface RemoveServiceInput {
  service_name: string
}

export const removeService: Tool<RemoveServiceInput> = {
  name: 'remove_service',
  description:
    `Remove a service from the catalog (soft delete — sets active=false). After removal Caye ` +
    `stops listing it, stops quoting it, and stops accepting bookings against it. Existing ` +
    `bookings on this service are NOT affected. ${HIGH_RISK_CONFIRMATION_PREAMBLE}`,
  risk: 'high',
  roles: ['owner', 'founder'],
  inputSchema: {
    type: 'object',
    properties: {
      service_name: { type: 'string', description: 'Service name as the owner said it.' },
    },
    required: ['service_name'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const lookup = await resolveServiceByName(supabase, ctx.workspaceId, args.service_name)
    if (!lookup.ok) return lookup

    if (!lookup.service.active) {
      return { ok: false, error: `${lookup.service.name} is already removed (inactive).` }
    }

    const { error } = await supabase
      .from('booking_services')
      .update({ active: false })
      .eq('id', lookup.service.id)
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        service: lookup.service.name,
        removed: true,
        note: 'Existing bookings preserved; only future quoting + booking are blocked.',
      },
    }
  },
}
