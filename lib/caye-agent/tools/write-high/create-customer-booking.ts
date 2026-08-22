import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { createBookingFromCaye, type CreateBookingInput } from '@/lib/caye-reply'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace } from '../write-low/_guards'
import { HIGH_RISK_CONFIRMATION_PREAMBLE } from './_booking-helpers'

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
 * This is the operator-facing booking action. It is deliberately in the
 * high-risk registry: Caye gathers the customer, service, date, time and
 * party details from the thread and workspace records, stages the exact
 * calendar entry, then creates it after one fresh owner confirmation. The
 * operator confirms the result; they never have to open the calendar and
 * create it themselves.
 */
export const createCustomerBooking: Tool<CreateCustomerBookingInput> = {
  name: 'create_customer_booking',
  description: `Create a pending booking for a customer directly from the operator conversation. Use this when the owner has supplied or approved the booking details — do the work yourself; never tell the owner to create the booking in the calendar. First use search_threads/get_customer_history/get_services (and availability data when relevant) to resolve the exact customer and service. It creates status='pending', never 'confirmed', and runs the canonical duplicate guard before inserting. ${HIGH_RISK_CONFIRMATION_PREAMBLE}`,
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'The conversation this booking request came from.' },
      customer_name: { type: 'string' },
      customer_email: { type: 'string', description: 'Use the address from the customer thread or profile when available.' },
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
      // A calendar entry is not proof of payment or customer confirmation.
      // Keep the booking pending even when its creation was owner-approved.
      status: 'pending',
    }

    const result = await createBookingFromCaye(ctx.workspaceId, args.conversation_id, input, args.customer_email ?? null)
    if (!result.success) {
      return { ok: false, status: 'CONFLICT', error: result.error ?? 'Could not create booking.' }
    }
    return { ok: true, data: { booking_id: result.booking_id, status: 'pending' } }
  },
}
