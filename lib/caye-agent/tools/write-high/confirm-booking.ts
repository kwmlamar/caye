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

interface ConfirmBookingInput {
  booking_id: string
  notify_customer?: boolean
  notification_body?: string
}

export const confirmBooking: Tool<ConfirmBookingInput> = {
  name: 'confirm_booking',
  description: `Move a pending booking to confirmed status, optionally sending a confirmation message to the customer. ${HIGH_RISK_CONFIRMATION_PREAMBLE}`,
  risk: 'high',
  inputSchema: {
    type: 'object',
    properties: {
      booking_id: {
        type: 'string',
        description: 'The booking_id from get_calendar / get_recent_bookings / get_customer_history.',
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
      return { ok: false, error: 'Booking is cancelled — cannot confirm a cancelled booking. Reschedule a new one instead.' }
    }

    const { error } = await supabase
      .from('bookings')
      .update({ status: 'confirmed' })
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
        status: 'confirmed',
        customer_notified: notify.sent,
        notification_channel: notify.channel ?? null,
        notification_error: notify.error ?? null,
      },
    }
  },
}
