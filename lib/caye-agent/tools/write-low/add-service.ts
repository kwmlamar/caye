import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface AddServiceInput {
  name: string
  price_type: 'per_person' | 'flat'
  default_price: number
  duration_minutes?: number
  description?: string
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export const addService: Tool<AddServiceInput> = {
  name: 'add_service',
  description:
    "Add a new tour or service to the catalog. Use when the owner says \"add a new tour called " +
    "X — it's $Y per person, ~Z hours\" or similar.\n\n" +
    "Creates the booking_services row AND a single default pricing tier covering any group size " +
    "(min 1, max 50). The owner can break that tier into multiple tiers later with " +
    "update_service_price or a follow-up tool. Sets visibility='public' by default.\n\n" +
    "Defaults: duration_minutes=120 (2h) when omitted. Description optional but useful — Caye " +
    "uses it in proactive recommendations.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Service display name (e.g. "Sunset Snorkel Tour"). Must be 2+ chars.',
      },
      price_type: {
        type: 'string',
        enum: ['per_person', 'flat'],
        description: 'per_person = price is multiplied by group size. flat = price is the party total.',
      },
      default_price: {
        type: 'number',
        description: 'The single-tier price in whole dollars. For per_person, this is the per-person rate.',
      },
      duration_minutes: {
        type: 'number',
        description: 'Optional. Defaults to 120 (2h).',
      },
      description: {
        type: 'string',
        description: 'Optional one-liner. Surfaces in proactive recommendations.',
      },
    },
    required: ['name', 'price_type', 'default_price'],
  },

  async execute(args, ctx) {
    const name = args.name.trim()
    if (name.length < 2) return { ok: false, error: 'Service name is too short.' }
    if (!Number.isFinite(args.default_price) || args.default_price < 0) {
      return { ok: false, error: 'default_price must be a non-negative number.' }
    }
    const duration = args.duration_minutes && args.duration_minutes > 0 ? args.duration_minutes : 120
    const slug = slugify(name) || `service-${Date.now()}`

    const supabase = createServiceClient()

    // Reject duplicate names (case-insensitive) so the owner doesn't end up
    // with two "Heritage Tour" rows because the second one was added at a
    // different time.
    const { data: existing } = await supabase
      .from('booking_services')
      .select('id, name')
      .eq('user_id', ctx.workspaceId)
      .ilike('name', name)
    if (existing && existing.length > 0) {
      return {
        ok: false,
        error: `A service named "${(existing[0] as { name: string }).name}" already exists. Use update_service_price to change its pricing, or pick a different name.`,
      }
    }

    const { data: svc, error: svcErr } = await supabase
      .from('booking_services')
      .insert({
        user_id: ctx.workspaceId,
        name,
        slug,
        description: args.description?.trim() || null,
        duration_minutes: duration,
        max_capacity: 10,
        price_type: args.price_type,
        active: true,
        visibility: 'public',
      })
      .select('id, name, slug')
      .single()
    if (svcErr || !svc) return { ok: false, error: svcErr?.message ?? 'Insert failed' }

    const isFlat = args.price_type === 'flat'
    const tierLabel = isFlat ? `$${args.default_price} flat` : `$${args.default_price}/person`
    const { error: tierErr } = await supabase.from('service_pricing_tiers').insert({
      workspace_id: ctx.workspaceId,
      service_id: svc.id,
      tier_name: isFlat ? 'Flat' : 'Adult',
      group_size_min: 1,
      group_size_max: 50,
      price_amount: args.default_price,
      price_label: tierLabel,
      is_flat: isFlat,
      is_ambiguous_above: false,
      display_order: 10,
    })
    if (tierErr) {
      // Surface the warning but don't roll back the service — the owner can
      // add tiers manually and the service is still usable for non-priced
      // inquiries.
      return {
        ok: true,
        data: {
          service_id: svc.id,
          name: svc.name,
          slug: svc.slug,
          default_tier_added: false,
          tier_error: tierErr.message,
        },
      }
    }

    return {
      ok: true,
      data: {
        service_id: svc.id,
        name: svc.name,
        slug: svc.slug,
        default_tier_added: true,
        tier_label: tierLabel,
        visibility: 'public',
      },
    }
  },
}
