import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface ServiceRow {
  id: string
  name: string
  slug: string | null
  duration_minutes: number | null
  max_capacity: number | null
  is_shared: boolean | null
  active: boolean | null
  visibility: 'public' | 'private' | null
  description: string | null
}

interface TierRow {
  service_id: string
  tier_name: string
  group_size_min: number
  group_size_max: number
  price_amount: number | string
  price_label: string
  is_flat: boolean | null
  display_order: number | null
}

export const getServices: Tool<Record<string, never>> = {
  name: 'get_services',
  description:
    "List the full service catalog with pricing tiers, visibility, capacity, and duration. " +
    "Use when the operator asks \"what tours do we have?\", \"what's the price of the Heritage " +
    "Tour?\", or before calling update_service_price / set_service_visibility / remove_service " +
    "so you know the exact tier names and current prices.\n\n" +
    "Returns active services by default. Includes private services in the list but tagged as " +
    "such — the operator might want to update one even if it's not proactively offered to guests.",
  risk: 'read',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {},
  },

  async execute(_args, ctx) {
    const supabase = createServiceClient()

    const { data: services, error: svcErr } = await supabase
      .from('booking_services')
      .select('id, name, slug, duration_minutes, max_capacity, is_shared, active, visibility, description')
      .eq('user_id', ctx.workspaceId)
      .eq('active', true)
      .order('name')
    if (svcErr) return { ok: false, error: svcErr.message }

    const rows = (services ?? []) as ServiceRow[]
    if (rows.length === 0) {
      return { ok: true, data: { services: [], count: 0 } }
    }

    const { data: tiers, error: tierErr } = await supabase
      .from('service_pricing_tiers')
      .select('service_id, tier_name, group_size_min, group_size_max, price_amount, price_label, is_flat, display_order')
      .eq('workspace_id', ctx.workspaceId)
      .in('service_id', rows.map((r) => r.id))
      .order('display_order', { ascending: true })
    if (tierErr) return { ok: false, error: tierErr.message }

    const tiersByService = new Map<string, TierRow[]>()
    for (const t of (tiers ?? []) as TierRow[]) {
      if (!tiersByService.has(t.service_id)) tiersByService.set(t.service_id, [])
      tiersByService.get(t.service_id)!.push(t)
    }

    const items = rows.map((r) => ({
      service_id: r.id,
      name: r.name,
      slug: r.slug,
      duration_minutes: r.duration_minutes,
      max_capacity: r.max_capacity,
      is_shared: r.is_shared ?? false,
      visibility: r.visibility ?? 'public',
      description: r.description,
      tiers: (tiersByService.get(r.id) ?? []).map((t) => ({
        tier_name: t.tier_name,
        group_size_min: t.group_size_min,
        group_size_max: t.group_size_max,
        price_amount:
          typeof t.price_amount === 'string' ? parseFloat(t.price_amount) : t.price_amount,
        price_label: t.price_label,
        is_flat: t.is_flat ?? false,
      })),
    }))

    return {
      ok: true,
      data: {
        services: items,
        count: items.length,
      },
    }
  },
}
