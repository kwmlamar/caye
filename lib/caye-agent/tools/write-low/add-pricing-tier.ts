import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import { resolveServiceByName } from '../_catalog-helpers'

interface AddPricingTierInput {
  service_name: string
  tier_name: string
  group_size_min: number
  group_size_max: number
  price_amount: number
  is_flat: boolean
  variant?: string
}

interface ExistingTierRow {
  tier_name: string
  variant: string | null
  group_size_min: number
  group_size_max: number
  display_order: number | null
}

function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin <= bMax && bMin <= aMax
}

export const addPricingTier: Tool<AddPricingTierInput> = {
  name: 'add_pricing_tier',
  description:
    "Add a new pricing tier to an EXISTING service. Use when the owner says something like " +
    "\"add a 3-6 guest private rate of $215 per person to Full Bimini\" or \"North Bimini " +
    "Heritage needs a private option at $200 for solo guests.\"\n\n" +
    "Pass variant (e.g. 'shared', 'private') ONLY when this tour needs to distinguish two " +
    "different prices at the SAME group size (like Standard vs Private on the same tour) — " +
    "Caye will then ask the customer which they want before quoting. Omit variant for a plain " +
    "group-size tier (e.g. a new 'Private Group (7+)' band) where size alone determines price.\n\n" +
    "Rejects a tier that exactly overlaps an existing tier's group-size range AND variant — " +
    "that would make quoting ambiguous. To CHANGE an existing tier's price, use " +
    "update_service_price instead; this tool is for adding a genuinely new band.\n\n" +
    "For a brand-new service with its first single tier, use add_service instead.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      service_name: {
        type: 'string',
        description: 'Service name as the owner said it. Fuzzy-matched against the catalog.',
      },
      tier_name: {
        type: 'string',
        description: 'Human-facing label for this tier, e.g. "Private Family (3-6)".',
      },
      group_size_min: {
        type: 'number',
        description: 'Smallest party size this tier applies to (inclusive).',
      },
      group_size_max: {
        type: 'number',
        description: 'Largest party size this tier applies to (inclusive). Use 50 for "and up".',
      },
      price_amount: {
        type: 'number',
        description: 'Price in whole dollars. Per-person rate if is_flat=false, whole-party total if is_flat=true.',
      },
      is_flat: {
        type: 'boolean',
        description: 'true = price_amount is the whole-party total. false = price_amount is per-person, multiplied by group size.',
      },
      variant: {
        type: 'string',
        description:
          "Optional. Only set this when the tour needs a second price at the SAME group size " +
          "(e.g. 'standard' vs 'private'). Use a short, consistent lowercase key across all tiers " +
          "of this tour — Caye asks the customer to pick between them using this value.",
      },
    },
    required: ['service_name', 'tier_name', 'group_size_min', 'group_size_max', 'price_amount', 'is_flat'],
  },

  async execute(args, ctx) {
    if (!Number.isInteger(args.group_size_min) || args.group_size_min < 1) {
      return { ok: false, error: 'group_size_min must be a positive integer.' }
    }
    if (!Number.isInteger(args.group_size_max) || args.group_size_max < args.group_size_min) {
      return { ok: false, error: 'group_size_max must be an integer >= group_size_min.' }
    }
    if (!Number.isFinite(args.price_amount) || args.price_amount < 0) {
      return { ok: false, error: 'price_amount must be a non-negative number.' }
    }
    const tierName = args.tier_name.trim()
    if (tierName.length < 1) return { ok: false, error: 'tier_name is required.' }
    const variant = args.variant?.trim().toLowerCase() || null

    const supabase = createServiceClient()
    const lookup = await resolveServiceByName(supabase, ctx.workspaceId, args.service_name)
    if (!lookup.ok) return lookup

    const { data: existing, error: existErr } = await supabase
      .from('service_pricing_tiers')
      .select('tier_name, variant, group_size_min, group_size_max, display_order')
      .eq('service_id', lookup.service.id)
      .eq('workspace_id', ctx.workspaceId)
    if (existErr) return { ok: false, error: existErr.message }

    const rows = (existing ?? []) as ExistingTierRow[]

    if (rows.some(r => r.tier_name.toLowerCase() === tierName.toLowerCase())) {
      return { ok: false, error: `A tier named "${tierName}" already exists on ${lookup.service.name}.` }
    }

    const conflicting = rows.find(
      r =>
        (r.variant ?? null) === variant &&
        rangesOverlap(r.group_size_min, r.group_size_max, args.group_size_min, args.group_size_max)
    )
    if (conflicting) {
      return {
        ok: false,
        error:
          `New tier (${args.group_size_min}-${args.group_size_max}${variant ? `, variant="${variant}"` : ''}) ` +
          `overlaps existing tier "${conflicting.tier_name}" (${conflicting.group_size_min}-${conflicting.group_size_max}` +
          `${conflicting.variant ? `, variant="${conflicting.variant}"` : ''}). Adjust the range or variant, or use ` +
          `update_service_price to change the existing tier instead.`,
      }
    }

    const nextOrder = rows.length > 0 ? Math.max(...rows.map(r => r.display_order ?? 0)) + 10 : 10
    const label = args.is_flat
      ? `$${args.price_amount} ${args.group_size_min === args.group_size_max ? 'flat' : 'total'}`
      : `$${args.price_amount}/person`

    const { error: insErr } = await supabase.from('service_pricing_tiers').insert({
      workspace_id: ctx.workspaceId,
      service_id: lookup.service.id,
      tier_name: tierName,
      variant,
      group_size_min: args.group_size_min,
      group_size_max: args.group_size_max,
      price_amount: args.price_amount,
      price_label: label,
      is_flat: args.is_flat,
      is_ambiguous_above: false,
      display_order: nextOrder,
      source: 'owner_confirmed',
      confirmed_at: new Date().toISOString(),
    })
    if (insErr) return { ok: false, error: insErr.message }

    return {
      ok: true,
      data: {
        service: lookup.service.name,
        tier_name: tierName,
        variant,
        group_size_min: args.group_size_min,
        group_size_max: args.group_size_max,
        price_label: label,
      },
    }
  },
}
