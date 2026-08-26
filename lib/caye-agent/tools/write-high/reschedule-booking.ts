import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { syncBookingToCalendar } from '@/lib/calendar-sync'
import type { Tool } from '../types'
import {
  findOwnedBooking,
  maybeNotifyCustomer,
  HIGH_RISK_CONFIRMATION_PREAMBLE,
  NOTIFY_BODY_DESCRIPTION,
  NOTIFY_CUSTOMER_DESCRIPTION,
} from './_booking-helpers'
import { validateBookingTimeClaimsAgainstEvidence } from '../../consequential-claim-grounding'

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
  roles: ['owner', 'founder'],
  modes: ['back-office'],
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

    // Verify what was actually persisted rather than trusting the request
    // we just sent (2026-08-26 Sonja Pettus incident's required invariant:
    // "operator instruction -> authorized booking mutation -> authoritative
    // booking state updated successfully" — updated SUCCESSFULLY, not just
    // requested). Everything below reads FROM THIS ROW, never from
    // args.new_date/args.new_time again.
    const { data: persisted, error: verifyError } = await supabase
      .from('bookings')
      .select('booking_date, booking_time')
      .eq('id', args.booking_id)
      .maybeSingle()
    const persistedOk =
      !verifyError &&
      persisted &&
      persisted.booking_date === args.new_date &&
      (!args.new_time || persisted.booking_time?.slice(0, 5) === args.new_time)
    if (!persistedOk) {
      return {
        ok: false,
        error: `Booking update did not verifiably persist — nothing was communicated to the customer. Re-read booking ${args.booking_id} before retrying rather than assuming this reschedule took effect.`,
      }
    }

    const calendar = await syncBookingToCalendar(ctx.workspaceId, args.booking_id, 'upsert')
    const calendarDeferred = !calendar.synced && calendar.deferred === true

    // The model composes notification_body itself; ground it against the
    // row we just verified rather than trusting it matches. A mismatch
    // here (stale time, typo) must never reach the customer just because
    // the booking mutation succeeded — same invariant as send_reply's
    // UNGROUNDED_BOOKING_TIME check, applied to this tool's own dispatch
    // path (maybeNotifyCustomer bypasses send_reply/send_customer_reply
    // entirely, so it needs its own grounding here).
    const notificationConflict = args.notification_body
      ? validateBookingTimeClaimsAgainstEvidence(args.notification_body, persisted.booking_time)
      : null

    const notify = notificationConflict
      ? { sent: false, error: `Notification text not sent — ${notificationConflict}.` }
      : await maybeNotifyCustomer({
          workspaceId: ctx.workspaceId,
          bookingId: args.booking_id,
          conversationId: lookup.booking.conversation_id,
          notify: args.notify_customer ?? true,
          body: args.notification_body,
        })

    return {
      ok: true,
      deferred: calendarDeferred,
      operator_message: calendarDeferred
        ? 'Booking rescheduled. Zoho Calendar will catch up shortly.'
        : undefined,
      data: {
        booking_id: args.booking_id,
        new_date: persisted.booking_date,
        new_time: persisted.booking_time?.slice(0, 5) ?? null,
        customer_notified: notify.sent,
        notification_channel: 'channel' in notify ? notify.channel ?? null : null,
        notification_error: notify.error ?? null,
        calendar_synced: calendar.synced,
        calendar_sync_status: calendar.synced ? 'synced' : calendarDeferred ? 'pending' : 'not_applicable',
        calendar_event_id: calendar.synced ? calendar.event_id ?? null : null,
        calendar_sync_error: calendar.synced ? null : calendar.reason,
      },
    }
  },
}
