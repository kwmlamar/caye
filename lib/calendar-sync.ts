/**
 * calendar-sync.ts
 *
 * Mirrors a single booking to the workspace's external calendar (Zoho today).
 * Supabase is the local source of truth; Zoho is a mirror allowed to be late.
 * External mutation success is NOT treated as proof that the intended calendar
 * effect occurred. Every mutating path that has an external event id performs
 * an independent Zoho read-back before returning synced:true.
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
import { verifyCalendarDelete, verifyCalendarUpsert } from './calendar-effect-verification'
import { deriveEffectRetryDecision, type EffectVerificationStatus, type ExecutionReceipt } from './effect-verification'
import { verifyAndPersistEffect } from './effect-verification-store'

export type SyncAction = 'upsert' | 'delete'
export type SyncResult =
  | {
      synced: true
      action: 'create' | 'update' | 'delete'
      event_id?: string
      verification_status?: EffectVerificationStatus
    }
  | {
      synced: false
      reason: string
      deferred?: boolean
      verification_status?: EffectVerificationStatus
    }

/** Stable per (booking, action) so retries can never double-create an event. */
export function calendarIdempotencyKey(bookingId: string, action: SyncAction): string {
  return `zoho_calendar:${bookingId}:${action}`
}

async function enqueueCalendarRetry(args: {
  workspaceId: string
  bookingId: string
  action: SyncAction
  reason: string
}): Promise<boolean> {
  const enqueued = await enqueueOperation({
    workspaceId: args.workspaceId,
    operation: args.action === 'delete' ? 'zoho_calendar_delete' : 'zoho_calendar_upsert',
    payload: { booking_id: args.bookingId },
    idempotencyKey: calendarIdempotencyKey(args.bookingId, args.action),
    lastError: args.reason,
  })
  return enqueued.queued
}

function executionReceipt(args: {
  attemptedAt: string
  externalId?: string | null
  details?: Record<string, unknown>
}): ExecutionReceipt {
  return {
    ok: true,
    attemptedAt: args.attemptedAt,
    executedAt: new Date().toISOString(),
    externalId: args.externalId ?? null,
    details: args.details ?? null,
  }
}

export async function syncBookingToCalendar(
  workspaceId: string,
  bookingId: string,
  action: SyncAction
): Promise<SyncResult> {
  const requestedAt = new Date().toISOString()
  const supabase = createServiceClient()

  const { data: booking, error: bkErr } = await supabase
    .from('bookings')
    .select(
      'id, user_id, customer_name, booking_date, booking_time, number_of_people, duration_minutes, notes, zoho_event_id, service:booking_services(name, duration_minutes)'
    )
    .eq('id', bookingId)
    .single()

  if (bkErr || !booking) return { synced: false, reason: 'Booking not found' }
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

  let newlyCreatedEventId: string | null = null
  let createAttemptedAt: string | null = null

  try {
    if (action === 'delete') {
      if (!booking.zoho_event_id) {
        await cancelOperationsForKey(calendarIdempotencyKey(bookingId, 'upsert'))
        await markSyncState(bookingId, 'not_applicable', null)
        return { synced: true, action: 'delete' }
      }

      const attemptedAt = new Date().toISOString()
      await deleteZohoCalendarEvent(workspaceId, booking.zoho_event_id)
      const verification = await verifyCalendarDelete({
        workspaceId,
        bookingId,
        eventId: booking.zoho_event_id,
        bookingDate: booking.booking_date,
        requestedAt,
        execution: executionReceipt({
          attemptedAt,
          externalId: booking.zoho_event_id,
          details: { action: 'delete' },
        }),
      })

      if (verification.status !== 'VERIFIED') {
        const queued = await enqueueCalendarRetry({
          workspaceId,
          bookingId,
          action: 'delete',
          reason: `Calendar delete ${verification.status}: ${verification.reason}`,
        })
        await markSyncState(bookingId, queued ? 'pending' : 'failed', verification.reason)
        return {
          synced: false,
          reason: verification.reason,
          deferred: queued || undefined,
          verification_status: verification.status,
        }
      }

      const { error: clearErr } = await supabase
        .from('bookings')
        .update({ zoho_event_id: null })
        .eq('id', booking.id)
      if (clearErr) {
        await markSyncState(bookingId, 'failed', `Verified delete but could not clear event id: ${clearErr.message}`)
        return {
          synced: false,
          reason: `Zoho delete was verified, but local reconciliation failed: ${clearErr.message}`,
          verification_status: 'VERIFIED',
        }
      }

      await cancelOperationsForKey(calendarIdempotencyKey(bookingId, 'upsert'))
      await markSyncState(bookingId, 'not_applicable', null)
      return { synced: true, action: 'delete', verification_status: 'VERIFIED' }
    }

    if (booking.zoho_event_id) {
      const attemptedAt = new Date().toISOString()
      try {
        await updateZohoCalendarEvent(workspaceId, booking.zoho_event_id, eventInput)
      } catch (err) {
        if (classifyError(err, 'ZOHO_CALENDAR_UPDATE_FAILED').status !== 'NOT_FOUND') throw err
        console.warn(
          `[calendar-sync] event ${booking.zoho_event_id} is gone from Zoho; recreating for booking ${booking.id}`
        )
        const { error: clearDeadIdErr } = await supabase
          .from('bookings')
          .update({ zoho_event_id: null })
          .eq('id', booking.id)
        if (clearDeadIdErr) throw clearDeadIdErr
      }

      if (booking.zoho_event_id) {
        const verification = await verifyCalendarUpsert({
          workspaceId,
          bookingId,
          eventId: booking.zoho_event_id,
          booking: eventInput,
          requestedAt,
          execution: executionReceipt({
            attemptedAt,
            externalId: booking.zoho_event_id,
            details: { action: 'update' },
          }),
        })
        if (verification.status === 'VERIFIED') {
          await markSyncState(bookingId, 'synced', null)
          return {
            synced: true,
            action: 'update',
            event_id: booking.zoho_event_id,
            verification_status: 'VERIFIED',
          }
        }

        const queued = await enqueueCalendarRetry({
          workspaceId,
          bookingId,
          action: 'upsert',
          reason: `Calendar update ${verification.status}: ${verification.reason}`,
        })
        await markSyncState(bookingId, queued ? 'pending' : 'failed', verification.reason)
        return {
          synced: false,
          reason: verification.reason,
          deferred: queued || undefined,
          verification_status: verification.status,
        }
      }
    }

    createAttemptedAt = new Date().toISOString()
    const eventId = await createZohoCalendarEvent(workspaceId, eventInput)
    newlyCreatedEventId = eventId

    // Persist the external identity before any retry can be queued. If this
    // write fails, re-executing would risk creating a second Zoho event.
    const { error: persistIdErr } = await supabase
      .from('bookings')
      .update({ zoho_event_id: eventId })
      .eq('id', booking.id)
    if (persistIdErr) {
      const verification = await verifyCalendarUpsert({
        workspaceId,
        bookingId,
        eventId,
        booking: eventInput,
        requestedAt,
        execution: executionReceipt({ attemptedAt: createAttemptedAt, externalId: eventId, details: { action: 'create' } }),
      })
      const reason =
        `Zoho event creation is ${verification.status}, but its external id could not be persisted locally; ` +
        `automatic retry is blocked to avoid a duplicate event. ${persistIdErr.message}`
      await markSyncState(bookingId, 'failed', reason)
      return { synced: false, reason, verification_status: verification.status }
    }

    const verification = await verifyCalendarUpsert({
      workspaceId,
      bookingId,
      eventId,
      booking: eventInput,
      requestedAt,
      execution: executionReceipt({ attemptedAt: createAttemptedAt, externalId: eventId, details: { action: 'create' } }),
    })

    if (verification.status === 'VERIFIED') {
      await markSyncState(bookingId, 'synced', null)
      return {
        synced: true,
        action: 'create',
        event_id: eventId,
        verification_status: 'VERIFIED',
      }
    }

    const retryDecision = deriveEffectRetryDecision({ status: verification.status, actionKind: 'create' })
    if (!retryDecision.retryMutation) {
      await markSyncState(bookingId, 'failed', retryDecision.reason)
      return { synced: false, reason: retryDecision.reason, verification_status: verification.status }
    }

    const queued = await enqueueCalendarRetry({
      workspaceId,
      bookingId,
      action: 'upsert',
      reason: `Calendar create ${verification.status}: ${verification.reason}`,
    })
    await markSyncState(bookingId, queued ? 'pending' : 'failed', verification.reason)
    return {
      synced: false,
      reason: verification.reason,
      deferred: queued || undefined,
      verification_status: verification.status,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const classified = classifyError(err, 'ZOHO_CALENDAR_SYNC_FAILED')

    // A create exception can happen after the provider accepted the request.
    // Persist the ambiguity and block mutation retry until read-back/reconciliation.
    if (createAttemptedAt) {
      const ambiguousExecution: ExecutionReceipt = {
        ok: true,
        attemptedAt: createAttemptedAt,
        executedAt: null,
        externalId: newlyCreatedEventId,
        error: `Ambiguous create outcome: ${msg}`,
        details: { action: 'create', provider_status: classified.status },
      }
      const verification = await verifyAndPersistEffect({
        workspaceId,
        effectId: `${bookingId}:calendar:upsert`,
        effect: 'zoho_calendar_upsert',
        actionKind: 'create',
        idempotencyKey: calendarIdempotencyKey(bookingId, 'upsert'),
        intendedEffect: eventInput as unknown as Record<string, unknown>,
        expectedState: eventInput as unknown as Record<string, unknown>,
        authorityRef: `booking_workspace:${bookingId}`,
        providerIdentity: 'zoho_calendar',
        observationProviderIdentity: 'zoho_calendar',
        requestedAt,
        execution: ambiguousExecution,
        observation: null,
        retrySafe: false,
        recoveryState: 'observe_only',
        ambiguityReason: 'Provider call failed after create was attempted; the event may already exist.',
      })
      const retryDecision = deriveEffectRetryDecision({
        status: verification.status,
        actionKind: 'create',
        providerFailureRetryable: classified.status === 'FAILED_RETRYABLE',
      })
      const reason = `${retryDecision.reason}. ${msg}`
      console.error(`[calendar-sync] ambiguous create for booking ${booking.id}: ${reason}`)
      await markSyncState(bookingId, 'failed', reason)
      return { synced: false, reason, verification_status: 'INDETERMINATE' }
    }

    if (classified.status !== 'FAILED_RETRYABLE') {
      console.error(`[calendar-sync] ${action} permanently failed for booking ${booking.id}:`, msg)
      await markSyncState(bookingId, 'failed', msg)
      return { synced: false, reason: msg, verification_status: 'FAILED' }
    }

    const queued = await enqueueCalendarRetry({ workspaceId, bookingId, action, reason: msg })
    if (!queued) {
      console.error(`[calendar-sync] ${action} failed AND could not queue for booking ${booking.id}:`, msg)
      await markSyncState(bookingId, 'failed', msg)
      return { synced: false, reason: msg, verification_status: 'FAILED' }
    }

    console.warn(`[calendar-sync] ${action} deferred for booking ${booking.id}: ${msg}`)
    await markSyncState(bookingId, 'pending', msg)
    return { synced: false, reason: msg, deferred: true, verification_status: 'FAILED' }
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
