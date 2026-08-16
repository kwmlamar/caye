import 'server-only'
import { findBookings } from '@/lib/caye-reply'
import type { Tool } from '../../types'

/**
 * front-desk/find-bookings.ts
 *
 * PHASE 2 of runtime convergence (2026-08-16) — thin adapter over the
 * canonical `findBookings` in `lib/caye-reply.ts` (exported for this
 * purpose). Email-first, name-fallback identity matching stays exactly as
 * production defines it; `matched_by` still tells the caller when a hit
 * came from a weaker (name-only) match so it isn't treated as verified
 * identity.
 */

interface FindBookingsInput {
  customer_email?: string
  customer_name?: string
}

export const findBookingsTool: Tool<FindBookingsInput> = {
  name: 'find_bookings',
  description:
    'Look up existing active (confirmed/pending), future-dated bookings for a customer. ' +
    'ALWAYS call this BEFORE discussing changes to an existing booking. Match by ' +
    'customer_email first; customer_name is a fallback only used when email returns nothing — ' +
    'in that case `matched_by` comes back "name", meaning identity is not verified; ask before ' +
    'acting on it. If match_count is 0, do not assume no booking exists — say you could not find ' +
    'one and ask for more detail rather than asserting there is none.',
  risk: 'read',
  roles: ['owner', 'staff', 'founder', 'driver'],
  modes: ['front-desk'],
  inputSchema: {
    type: 'object',
    properties: {
      customer_email: { type: 'string', description: "The customer's email — primary match key." },
      customer_name: {
        type: 'string',
        description: 'Customer name — fallback when email lookup returns nothing.',
      },
    },
  },

  async execute(args, ctx) {
    if (!args.customer_email && !args.customer_name) {
      return { ok: false, error: 'Provide customer_email or customer_name.' }
    }
    const result = await findBookings(ctx.workspaceId, args)
    // Phase 3: 'customer_identified' only on a verified (email) match — a
    // name-only fallback hit is explicitly NOT verified identity per the
    // tool description above, so it must not count as evidence.
    if (result.matched_by === 'email' && result.match_count > 0) {
      ctx.evidenceCollected?.push('customer_identified')
    }
    if (result.match_count > 0) {
      ctx.evidenceCollected?.push('booking_exists')
    }
    return { ok: true, data: result }
  },
}
