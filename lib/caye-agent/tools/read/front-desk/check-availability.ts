import 'server-only'
import { checkAvailability } from '@/lib/caye-reply'
import type { Tool } from '../../types'

/**
 * front-desk/check-availability.ts
 *
 * PHASE 2 of runtime convergence (2026-08-16) — thin adapter over the
 * canonical `checkAvailability` in `lib/caye-reply.ts` (exported for this
 * purpose; logic itself is untouched). Wraps rather than duplicates: the
 * blackout-date/owner-only-weekday rules and shared-capacity math live in
 * exactly one place, same as they do for production front-desk today.
 */

interface CheckAvailabilityInput {
  date: string
}

export const checkAvailabilityTool: Tool<CheckAvailabilityInput> = {
  name: 'check_availability',
  description:
    'Look up what bookings already exist on a given date for this business, and whether the ' +
    'business is closed or owner-only that day. ALWAYS call this before quoting a date or ' +
    'proposing a booking so you can recommend an open slot and avoid double-booking. Returns ' +
    'existing bookings with time/duration/party size, plus closed/owner_only flags when the ' +
    "date isn't open for Caye to handle directly.",
  risk: 'read',
  roles: ['owner', 'staff', 'founder', 'driver'],
  modes: ['front-desk'],
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'The date to check, in YYYY-MM-DD format.' },
    },
    required: ['date'],
  },

  async execute(args, ctx) {
    if (!args.date) return { ok: false, error: 'date is required.' }
    const result = await checkAvailability(ctx.workspaceId, args.date)
    // Phase 3: a concrete date was supplied and the availability rules were
    // actually evaluated for it (regardless of the answer) — evidence.ts's
    // send_customer_reply gate reads this back to permit an availability
    // claim in the same turn's draft.
    ctx.evidenceCollected?.push('date_identified', 'availability_verified')
    return { ok: true, data: result }
  },
}
