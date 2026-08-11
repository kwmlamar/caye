/**
 * calendar-sync.ts
 *
 * Mirrors a single booking to the workspace's external calendar (Zoho today).
 * Used by /api/calendar/sync (BookingModal), every channel webhook, and the
 * agent's own booking tools — 11 call sites, all fire-and-forget.
 *
 * LOCAL-FIRST (2026-08-11)
 * Supabase is the source of truth; Zoho is a mirror allowed to be late.
 * Previously a Zoho outage meant the event silently never existed: the catch
 * below logged to console, returned { synced: false }, and every caller
 * discarded it via `.catch(() => {})`. Nothing retried. Nothing recorded that
 * the owner's calendar was now wrong.
 *
 * Now a transient failure enqueues the intent in caye_pending_operations and
 * marks bookings.calendar_sync_status = 'pending'. The booking is real either
 * way; /api/caye/operation-worker owns catching Zoho up.
 *
 * The signature and the { synced: false, reason } shape are unchanged, so all
 * 11 call sites keep working untouched.
 */

import 'server-only'
import { createServiceClient } from './supabase-server'
import { enqueueOperation, cancelOperationsForKey } from './pending-operations'
import { classifyError } from './caye-agent/tools/result'
import {
  createZohoCalendarEvent,
  updateZohoCalendarEvent,
  deleteZohoCalendarEvent,
  type BookingEventInput,
} from './zoho-calendar'

export type SyncAction = 'upsert' | 'delete'
export type SyncResult =
  | { synced: true; action: 'create' | 'update' | 'delete'; event_id?: string }
  /**
   * `deferred: true` means the mirror is queued and will be retried — the
   * booking itself is committed and correct. Distinct from a plain
   * { synced: false }, which means we deliberately did nothing (sync off, no
   * Zoho account) and there is nothing to catch up.
   */
  | { synced: false; reason: string; deferred?: boolean }

/** Stable per (booking, action) so retries can never double-create an event. */
export function calendarIdempotencyKey(bookingId: string, action: SyncAction): string {
  return `zoho_calendar:${bookingId}:${action}`
}

export async function syncBookingToCalendar(
  workspaceId: string,
  bookingId: string,
  action: SyncAction
): Promise<SyncResult> {
  const supabase = createServiceClient()

  const { data: booking, error: bkErr } = await supabase
    .from('bookings')
    .select(
      'id, user_id, customer_name, booking_date, booking_time, number_of_people, duration_minutes, notes, zoho_event_id, service:booking_services(name, duration_minutes)'
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

  // Nothing to mirror to. Record that explicitly rather than leaving the
  // column NULL — "no calendar connected" and "never tried" look identical
  // otherwise, and only one of them is worth chasing.
  if (!account) {
    await markSyncState(bookingId, 'not_applicable', null)
    return { synced: false, reason: 'No active Zoho email account' }
  }
  if (!account.sync_calendar) {
    await markSyncState(bookingId, 'not_applicable', null)
    return { synced: false, reason: 'Calendar sync disabled' }
  }

  const serviceArr = booking.service as { name: string; duration_minutes: number }[] | null
  const bk = booking as typeof booking & { duration_minutes: number | null }
  const eventInput: BookingEventInput = {
    customerName: booking.customer_name,
    serviceName: serviceArr?.[0]?.name ?? null,
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time,
    durationMinutes: bk.duration_minutes ?? serviceArr?.[0]?.duration_minutes ?? 120,
    numberOfPeople: booking.number_of_people,
    notes: booking.notes,
  }

  try {
    if (action === 'delete') {
      if (booking.zoho_event_id) {
        await deleteZohoCalendarEvent(workspaceId, booking.zoho_event_id)
        await supabase.from('bookings').update({ zoho_event_id: null }).eq('id', booking.id)
      }
      // A pending upsert for a booking we just deleted would recreate the
      // event on the next worker tick. Retire it.
      await cancelOperationsForKey(calendarIdempotencyKey(bookingId, 'upsert'))
      await markSyncState(bookingId, 'not_applicable', null)
      return { synced: true, action: 'delete' }
    }

    if (booking.zoho_event_id) {
      try {
        await updateZohoCalendarEvent(workspaceId, booking.zoho_event_id, eventInput)
        await markSyncState(bookingId, 'synced', null)
        return { synced: true, action: 'update', event_id: booking.zoho_event_id }
      } catch (err) {
        // The event was deleted in Zoho directly (a732dd6's ETAG lookup 404s
        // and throws "no longer exists"). Retrying an update against a
        // deleted event can never succeed, and leaving it means the booking
        // is simply absent from the owner's calendar forever. Recover by
        // forgetting the dead id and creating a fresh event below.
        if (classifyError(err, 'ZOHO_CALENDAR_UPDATE_FAILED').status !== 'NOT_FOUND') throw err
        console.warn(
          `[calendar-sync] event ${booking.zoho_event_id} is gone from Zoho; recreating for booking ${booking.id}`
        )
        await supabase.from('bookings').update({ zoho_event_id: null }).eq('id', booking.id)
      }
    }

    const eventId = await createZohoCalendarEvent(workspaceId, eventInput)
    // Verification, not assumption: createZohoCalendarEvent already throws
    // when Zoho returns no uid, so reaching here means we hold a real
    // external id — and we persist it before claiming success.
    await supabase.from('bookings').update({ zoho_event_id: eventId }).eq('id', booking.id)
    await markSyncState(bookingId, 'synced', null)
    return { synced: true, action: 'create', event_id: eventId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const classified = classifyError(err, 'ZOHO_CALENDAR_SYNC_FAILED')

    // Permanent failures (bad request, revoked scope) will not fix themselves
    // by being retried on a timer. Mark and stop; the health surface can
    // report it and a human can reconnect.
    if (classified.status !== 'FAILED_RETRYABLE') {
      console.error(`[calendar-sync] ${action} permanently failed for booking ${booking.id}:`, msg)
      await markSyncState(bookingId, 'failed', msg)
      return { synced: false, reason: msg }
    }

    const enqueued = await enqueueOperation({
      workspaceId,
      operation: action === 'delete' ? 'zoho_calendar_delete' : 'zoho_calendar_upsert',
      payload: { booking_id: bookingId },
      idempotencyKey: calendarIdempotencyKey(bookingId, action),
      lastError: msg,
    })

    if (!enqueued.queued) {
      // Could not even record the promise. Say so honestly rather than
      // implying a retry that will never come.
      console.error(`[calendar-sync] ${action} failed AND could not queue for booking ${booking.id}:`, msg)
      await markSyncState(bookingId, 'failed', msg)
      return { synced: false, reason: msg }
    }

    console.warn(`[calendar-sync] ${action} deferred for booking ${booking.id}: ${msg}`)
    await markSyncState(bookingId, 'pending', msg)
    return { synced: false, reason: msg, deferred: true }
  }
}

/** Best-effort — a booking must never fail because its status column didn't update. */
async function markSyncState(
  bookingId: string,
  status: 'pending' | 'synced' | 'failed' | 'not_applicable',
  error: string | null
): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { error: updErr } = await supabase
      .from('bookings')
      .update({
        calendar_sync_status: status,
        calendar_synced_at: status === 'synced' ? new Date().toISOString() : null,
        calendar_sync_error: error ? error.slice(0, 500) : null,
      })
      .eq('id', bookingId)
    if (updErr) {
      console.error(`[calendar-sync] could not record sync state for ${bookingId}:`, updErr.message)
    }
  } catch (err) {
    console.error(`[calendar-sync] markSyncState threw for ${bookingId}:`, err)
  }
}
