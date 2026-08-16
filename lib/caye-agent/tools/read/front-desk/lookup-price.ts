import 'server-only'
import { lookupPriceForCaye } from '@/lib/caye-reply'
import type { Tool } from '../../types'

/**
 * front-desk/lookup-price.ts
 *
 * PHASE 2 of runtime convergence (2026-08-16) — thin adapter over the
 * canonical `lookupPriceForCaye` in `lib/caye-reply.ts` (exported for this
 * purpose). Deterministic tier resolution (`lib/services/resolve-tier.ts`)
 * is the actual pricing-math authority; this tool never computes a price
 * itself. See resolve-tier.ts's own header for why that matters (the
 * Stallings 2026-05-29 mis-tiered pricing incident this logic exists to
 * prevent) — nothing about that guarantee changes by exposing it here.
 */

interface LookupPriceInput {
  service_id: string
  group_size: number
  variant?: string
}

export const lookupPriceTool: Tool<LookupPriceInput> = {
  name: 'lookup_price',
  description:
    'Resolve the EXACT price for a service + group size from the pricing tables. NEVER quote a ' +
    'price from memory — call this every time before mentioning a number. Returns ' +
    '{ ok: true, price_label, total_label, total_amount } to quote verbatim, or ' +
    '{ ok: false, hold, message, candidate_tiers } when the group size is ambiguous, out of ' +
    'range, or the tour has more than one price for this size (pass `variant` on a second call ' +
    'once the customer says which they want) — do not quote a number in that case.',
  risk: 'read',
  roles: ['owner', 'staff', 'founder', 'driver'],
  modes: ['front-desk'],
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service id from get_services.' },
      group_size: { type: 'number', description: 'Number of guests in the party.' },
      variant: {
        type: 'string',
        description:
          'Optional — only on a second call, after the first returned hold="multiple_tiers_matched" ' +
          'with variant-tagged candidates and the customer said which they want.',
      },
    },
    required: ['service_id', 'group_size'],
  },

  async execute(args, ctx) {
    if (!args.service_id) return { ok: false, error: 'service_id is required.' }
    if (!Number.isFinite(args.group_size) || args.group_size < 1) {
      return { ok: false, error: 'group_size must be a positive number.' }
    }
    const result = await lookupPriceForCaye(ctx.workspaceId, args.service_id, args.group_size, args.variant ?? null)
    // Phase 3: only a resolved (unambiguous) price counts as evidence — a
    // hold="multiple_tiers_matched" result is not a database-backed number
    // yet, so send_customer_reply must not be permitted to quote from it.
    if (result.ok) {
      ctx.evidenceCollected?.push('service_identified', 'party_size_identified', 'price_from_database')
    }
    return { ok: result.ok, data: result }
  },
}
