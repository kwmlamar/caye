import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import { resolveServiceByName } from '../_catalog-helpers'

interface UpdateServicePriceInput {
  service_name: string
  tier: string
  price: number
}

export const updateServicePrice: Tool<UpdateServicePriceInput> = {
  name: 'update_service_price',
  description:
    "Update the price for a specific tier of a service. Use when the owner says something like " +
    "\"Sit-Low private is $199, not $150\" or \"raise the Heritage Tour adult price to $90\".\n\n" +
    "Match the tier by tier_name as stored on the pricing row (e.g. 'Adult', 'Private (2 max)', " +
    "'Private Group (min 4)'). Pass the new whole-dollar amount as a number — the existing " +
    "price_label is rebuilt automatically from the amount + tier flat/per-person shape.\n\n" +
    "If the owner is vague about which tier (\"the Sit-Low price is wrong\"), call " +
    "query_business_knowledge or just ask which tier — never guess. Pricing mistakes are the " +
    "category that caused the Stallings incident; we don't fix one by introducing another.",
  risk: 'low',
  roles: ['owner', 'founder'],
  inputSchema: {
    type: 'object',
    properties: {
      service_name: {
        type: 'string',
        description: 'Service name as the owner said it. Fuzzy-matched against the catalog.',
      },
      tier: {
        type: 'string',
        description: 'Tier name as stored on the pricing row (e.g. "Adult", "Private (2 max)").',
      },
      price: {
        type: 'number',
        description: 'New price amount in whole dollars (the unit, not the cents).',
      },
    },
    required: ['service_name', 'tier', 'price'],
  },

  async execute(args, ctx) {
    if (!Number.isFinite(args.price) || args.price < 0) {
      return { ok: false, error: 'Price must be a non-negative number.' }
    }
    const supabase = createServiceClient()
    const lookup = await resolveServiceByName(supabase, ctx.workspaceId, args.service_name)
    if (!lookup.ok) return lookup

    const tierName = args.tier.trim()
    const { data: tiers, error: tierErr } = await supabase
      .from('service_pricing_tiers')
      .select('id, tier_name, is_flat, price_label')
      .eq('service_id', lookup.service.id)
      .eq('workspace_id', ctx.workspaceId)
    if (tierErr) return { ok: false, error: tierErr.message }
    const matched = (tiers ?? []).find(
      (t: { tier_name: string }) =>
        t.tier_name.toLowerCase() === tierName.toLowerCase()
    )
    if (!matched) {
      return {
        ok: false,
        error: `Tier "${tierName}" not found on ${lookup.service.name}.`,
        data: { available_tiers: (tiers ?? []).map((t: { tier_name: string }) => t.tier_name) },
      }
    }

    const newLabel = matched.is_flat
      ? `$${args.price} flat`
      : `$${args.price}/person`

    const { error: updErr } = await supabase
      .from('service_pricing_tiers')
      .update({
        price_amount: args.price,
        price_label: newLabel,
        updated_at: new Date().toISOString(),
      })
      .eq('id', matched.id)
    if (updErr) return { ok: false, error: updErr.message }

    return {
      ok: true,
      data: {
        service: lookup.service.name,
        tier: matched.tier_name,
        new_price_amount: args.price,
        new_price_label: newLabel,
      },
    }
  },
}
