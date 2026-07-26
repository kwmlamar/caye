import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import { resolveServiceByName } from '../_catalog-helpers'
import { HIGH_RISK_CONFIRMATION_PREAMBLE } from './_booking-helpers'

interface RemovePricingTierInput {
  service_name: string
  tier_name: string
}

export const removePricingTier: Tool<RemovePricingTierInput> = {
  name: 'remove_pricing_tier',
  description:
    `Delete a single pricing tier from a service (e.g. the owner discontinues a "Private Group ` +
    `(7+)" rate but keeps the rest of the tour's pricing). Match tier_name exactly as stored ` +
    `(call get_services first if unsure). Removing the ONLY tier on a service leaves it with no ` +
    `price at all — Caye will hold every quote for that service until a new tier is added; warn ` +
    `the owner if this is the last tier. To remove an entire tour, use remove_service instead. ` +
    `${HIGH_RISK_CONFIRMATION_PREAMBLE}`,
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      service_name: { type: 'string', description: 'Service name as the owner said it.' },
      tier_name: { type: 'string', description: 'Tier name exactly as stored (e.g. "Private Group (7+)").' },
    },
    required: ['service_name', 'tier_name'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const lookup = await resolveServiceByName(supabase, ctx.workspaceId, args.service_name)
    if (!lookup.ok) return lookup

    const { data: tiers, error: tierErr } = await supabase
      .from('service_pricing_tiers')
      .select('id, tier_name')
      .eq('service_id', lookup.service.id)
      .eq('workspace_id', ctx.workspaceId)
    if (tierErr) return { ok: false, error: tierErr.message }

    const rows = (tiers ?? []) as { id: string; tier_name: string }[]
    const tierNameInput = args.tier_name.trim()
    const matched = rows.find(t => t.tier_name.toLowerCase() === tierNameInput.toLowerCase())

    if (!matched) {
      return {
        ok: false,
        error: `Tier "${tierNameInput}" not found on ${lookup.service.name}.`,
        data: { available_tiers: rows.map(t => t.tier_name) },
      }
    }

    const { error: delErr } = await supabase
      .from('service_pricing_tiers')
      .delete()
      .eq('id', matched.id)
    if (delErr) return { ok: false, error: delErr.message }

    const remaining = rows.length - 1

    return {
      ok: true,
      data: {
        service: lookup.service.name,
        removed_tier: matched.tier_name,
        remaining_tiers: remaining,
        warning: remaining === 0 ? 'This was the last tier — Caye can no longer quote this service until a new tier is added.' : undefined,
      },
    }
  },
}
