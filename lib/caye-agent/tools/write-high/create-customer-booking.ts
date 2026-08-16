import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { createBookingFromCaye, type CreateBookingInput } from '@/lib/caye-reply'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace } from '../write-low/_guards'
import { evaluateAction, type EvidenceSet } from '../../evidence'

interface CreateCustomerBookingInput {
  conversation_id: string
  customer_name: string
  customer_email?: string
  customer_phone?: string
  service_id: string
  booking_date: string
  booking_time: string
  number_of_people: number
  duration_minutes?: number
  notes?: string
}

/**
 * write-high/create-customer-booking.ts
 *
 * PHASE 3 of runtime convergence (2026-08-16) — thin adapter over the
 * canonical `createBookingFromCaye` in `lib/caye-reply.ts` (exported for
 * this purpose; the duplicate-booking guard — `findDuplicateBooking`, the
 * fix for the real 2026-08-11 Karin Roberts double-booking — and the
 * `status` default of 'pending' are untouched, same code path production
 * uses). Selected as the one write beyond `send_customer_reply` this phase
 * ports, per the brief's own steer: it has no time-window autonomy gate
 * (unlike cancel/reschedule's `checkBookingAutonomy`, which reflects a
 * philosophical autonomous-by-default design this phase deliberately does
 * not resolve — see report §12), just a dedup check, and a conservative
 * default status. Cancellation, reschedule, and any payment/refund action
 * are deferred — not built, not stubbed — exactly as instructed.
 *
 * Evidence-gated the same way as `send_customer_reply`, reusing the
 * ALREADY-DEFINED `create_booking` requirement list in `evidence.ts`
 * (customer_identified, service_identified, date_identified,
 * party_size_identified, availability_verified) rather than inventing a
 * parallel check — this is the exact ladder `evidence.ts`'s own comments
 * describe a booking as needing ("the whole picture"). Missing evidence
 * blocks the insert entirely; `createBookingFromCaye` is never even
 * called, so there is no code path where an ungrounded booking reaches
 * the `bookings` table.
 *
 * Not wrapped in `gateHighRisk` — same reasoning as `send_customer_reply`
 * (see that file's header comment): there is no operator naturally in the
 * loop to supply a second confirming request for a routine, evidence-
 * sufficient booking, and gating every one behind a human round-trip would
 * be a regression from what `lib/caye-reply.ts` already does autonomously
 * in production today.
 */
export const createCustomerBooking: Tool<CreateCustomerBookingInput> = {
  name: 'create_customer_booking',
  description: `Create a booking for the customer on this conversation. HIGH-RISK, but conservative by construction: creates status='pending' (never 'confirmed') and refuses to run at all unless you've verified the customer's identity, service, date, party size, and availability with real tool calls first — check_availability, lookup_price (or get_services), and find_bookings (to attach a verified customer_email) THIS turn. If anything is missing, nothing is created and you get back exactly what's missing — call the missing tool, don't guess.

A duplicate-booking check runs before the insert (same guest, same day) — a hit is returned as an error to address with the customer, not a success.`,
  risk: 'high',
  roles: ['owner', 'staff', 'founder'],
  modes: ['front-desk'],
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'The conversation this booking request came from.' },
      customer_name: { type: 'string' },
      customer_email: { type: 'string', description: 'Required to count as verified identity — pass the one find_bookings matched on, or the one the customer gave directly in this thread.' },
      customer_phone: { type: 'string' },
      service_id: { type: 'string', description: 'Service id from get_services / lookup_price.' },
      booking_date: { type: 'string', description: 'YYYY-MM-DD.' },
      booking_time: { type: 'string', description: 'HH:MM, 24h.' },
      number_of_people: { type: 'number' },
      duration_minutes: { type: 'number' },
      notes: { type: 'string' },
    },
    required: ['conversation_id', 'customer_name', 'service_id', 'booking_date', 'booking_time', 'number_of_people'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const owned = await assertConversationOwnedByWorkspace(supabase, args.conversation_id, ctx.workspaceId)
    if (!owned.ok) return owned

    const evidence: EvidenceSet = new Set(ctx.evidenceCollected ?? [])
    const verdict = evaluateAction('create_booking', evidence)
    if (!verdict.permitted) {
      return {
        ok: false,
        status: 'NEEDS_HUMAN',
        error_code: 'INSUFFICIENT_EVIDENCE',
        error: `Not enough verified to create this booking yet — missing: ${verdict.missing.join(', ')}. Call the tool(s) that establish those before trying again.`,
        data: { missing: verdict.missing },
      }
    }

    const input: CreateBookingInput = {
      customer_name: args.customer_name,
      customer_email: args.customer_email,
      customer_phone: args.customer_phone,
      service_id: args.service_id,
      booking_date: args.booking_date,
      booking_time: args.booking_time,
      number_of_people: args.number_of_people,
      duration_minutes: args.duration_minutes,
      notes: args.notes,
      // Evidence gate above never includes 'payment_verified', so this tool
      // can never legally claim confirmed — createBookingFromCaye's own
      // default already enforces this, spelled out here so the invariant
      // doesn't silently depend on that default never changing.
      status: 'pending',
    }

    const result = await createBookingFromCaye(ctx.workspaceId, args.conversation_id, input, args.customer_email ?? null)
    if (!result.success) {
      return { ok: false, status: 'CONFLICT', error: result.error ?? 'Could not create booking.' }
    }
    return { ok: true, data: { booking_id: result.booking_id, status: 'pending' } }
  },
}
