/**
 * calendar-sync.ts
 *
 * Shared helper that mirrors a single booking to the workspace's external
 * calendar (Zoho today). Used by both /api/calendar/sync (BookingModal calls)
 * and the channel webhook handlers (when Caye creates a booking from chat).
 *
 * No-op (returns { synced: false, reason }) if the user has no Zoho account
 * or sync_calendar is off. Failures are caught and returned in the same shape
 * so callers can fire-and-forget without try/catch.
 */

import 'server-only'
import { createServiceClient } from './supabase-server'
import {
  createZohoCalendarEvent,
  updateZohoCalendarEvent,
  deleteZohoCalendarEvent,
  type BookingEventInput,
} from './zoho-calendar'

export type SyncAction = 'upsert' | 'delete'
export type SyncResult =
  | { synced: true; action: 'create' | 'update' | 'delete'; event_id?: string }
  | { synced: false; reason: string }

export async function syncBookingToCalendar(
  workspaceId: string,
  bookingId: string,
  action: SyncAction
): Promise<SyncResult> {
  const supabase = createServiceClient()

  const { data: booking, error: bkErr } = await supabase
    .from('bookings')
    .select(
      'id, user_id, customer_name, booking_date, booking_time, number_of_people, notes, zoho_event_id, service:booking_services(name, duration_minutes)'
    )
    .eq('id', bookingId)
    .single()

  if (bkErr || !booking) {
    return { synced: false, reason: 'Booking not found' }
  }
  if (booking.user_id !== workspaceId) {
    return { synced: false, reason: 'Booking does not belong to workspace' }
  }

  const { data: account } = await supabase
    .from('connected_accounts')
    .select('sync_calendar')
    .eq('user_id', workspaceId)
    .eq('channel_type', 'email')
    .eq('is_active', true)
    .maybeSingle()

  if (!account) return { synced: false, reason: 'No active Zoho email account' }
  if (!account.sync_calendar) return { synced: false, reason: 'Calendar sync disabled' }

  const serviceArr = booking.service as { name: string; duration_minutes: number }[] | null
  const eventInput: BookingEventInput = {
    customerName: booking.customer_name,
    serviceName: serviceArr?.[0]?.name ?? null,
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time,
    durationMinutes: serviceArr?.[0]?.duration_minutes ?? 120,
    numberOfPeople: booking.number_of_people,
    notes: booking.notes,
  }

  try {
    if (action === 'delete') {
      if (booking.zoho_event_id) {
        await deleteZohoCalendarEvent(workspaceId, booking.zoho_event_id)
        await supabase.from('bookings').update({ zoho_event_id: null }).eq('id', booking.id)
      }
      return { synced: true, action: 'delete' }
    }

    if (booking.zoho_event_id) {
      await updateZohoCalendarEvent(workspaceId, booking.zoho_event_id, eventInput)
      return { synced: true, action: 'update', event_id: booking.zoho_event_id }
    }

    const eventId = await createZohoCalendarEvent(workspaceId, eventInput)
    await supabase.from('bookings').update({ zoho_event_id: eventId }).eq('id', booking.id)
    return { synced: true, action: 'create', event_id: eventId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[calendar-sync] ${action} failed for booking ${booking.id}:`, msg)
    return { synced: false, reason: msg }
  }
}
