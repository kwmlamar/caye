import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import {
  findOwnedBooking,
  maybeNotifyCustomer,
  HIGH_RISK_CONFIRMATION_PREAMBLE,
  NOTIFY_BODY_DESCRIPTION,
  NOTIFY_CUSTOMER_DESCRIPTION,
} from './_booking-helpers'

interface CancelBookingInput {
  booking_id: string
  reason?: string
  notify_customer?: boolean
  notification_body?: string
}

export const cancelBooking: Tool<CancelBookingInput> = {
  name: 'cancel_booking',
  description: `Cancel a booking, recording the reason and notifying the customer. ${HIGH_RISK_CONFIRMATION_PREAMBLE}`,
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      booking_id: {
        type: 'string',
        description: 'The booking_id from get_calendar / get_recent_bookings / get_customer_history.',
      },
      reason: {
        type: 'string',
        description: 'Short internal cancellation reason — stored on the booking for audit. e.g. "weather", "customer requested", "double-booked".',
      },
      notify_customer: {
        type: 'boolean',
        description: NOTIFY_CUSTOMER_DESCRIPTION,
      },
      notification_body: {
        type: 'string',
        description: NOTIFY_BODY_DESCRIPTION,
      },
    },
    required: ['booking_id'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const lookup = await findOwnedBooking(supabase, args.booking_id, ctx.workspaceId)
    if (!lookup.ok) return lookup

    if (lookup.booking.status === 'cancelled') {
      return { ok: false, error: 'Booking is already cancelled.' }
    }

    const update: Record<string, unknown> = {
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
    }
    if (args.reason?.trim()) {
      // Append to notes rather than overwrite — keeps any prior context.
      const existingNotes = lookup.booking as unknown as { notes?: string | null }
      const stamp = `Cancelled ${new Date().toISOString().slice(0, 10)}: ${args.reason.trim()}`
      update.notes = existingNotes.notes ? `${existingNotes.notes}\n${stamp}` : stamp
    }
    const { error } = await supabase
      .from('bookings')
      .update(update)
      .eq('id', args.booking_id)
    if (error) return { ok: false, error: error.message }

    const notify = await maybeNotifyCustomer({
      conversationId: lookup.booking.conversation_id,
      notify: args.notify_customer ?? true,
      body: args.notification_body,
    })

    return {
      ok: true,
      data: {
        booking_id: args.booking_id,
        status: 'cancelled',
        reason: args.reason?.trim() ?? null,
        customer_notified: notify.sent,
        notification_channel: notify.channel ?? null,
        notification_error: notify.error ?? null,
      },
    }
  },
}
