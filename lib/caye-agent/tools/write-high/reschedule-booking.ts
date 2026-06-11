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

interface RescheduleBookingInput {
  booking_id: string
  new_date: string
  new_time?: string
  notify_customer?: boolean
  notification_body?: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^\d{2}:\d{2}(:\d{2})?$/

export const rescheduleBooking: Tool<RescheduleBookingInput> = {
  name: 'reschedule_booking',
  description: `Move a booking to a new date (and optionally a new time), notifying the customer. ${HIGH_RISK_CONFIRMATION_PREAMBLE}`,
  risk: 'high',
  inputSchema: {
    type: 'object',
    properties: {
      booking_id: {
        type: 'string',
        description: 'The booking_id from get_calendar / get_recent_bookings / get_customer_history.',
      },
      new_date: {
        type: 'string',
        description: 'New booking date in YYYY-MM-DD format.',
      },
      new_time: {
        type: 'string',
        description: 'Optional new booking time in HH:MM format. Omit to keep the current time.',
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
    required: ['booking_id', 'new_date'],
  },

  async execute(args, ctx) {
    if (!ISO_DATE.test(args.new_date)) {
      return { ok: false, error: 'new_date must be YYYY-MM-DD' }
    }
    if (args.new_time && !HHMM.test(args.new_time)) {
      return { ok: false, error: 'new_time must be HH:MM (24h)' }
    }

    const supabase = createServiceClient()
    const lookup = await findOwnedBooking(supabase, args.booking_id, ctx.workspaceId)
    if (!lookup.ok) return lookup

    if (lookup.booking.status === 'cancelled') {
      return { ok: false, error: 'Booking is cancelled — cannot reschedule. Confirm or recreate it.' }
    }

    const update: Record<string, unknown> = { booking_date: args.new_date }
    if (args.new_time) {
      update.booking_time = args.new_time.length === 5 ? `${args.new_time}:00` : args.new_time
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
        new_date: args.new_date,
        new_time: args.new_time ?? lookup.booking.booking_time?.slice(0, 5) ?? null,
        customer_notified: notify.sent,
        notification_channel: notify.channel ?? null,
        notification_error: notify.error ?? null,
      },
    }
  },
}
