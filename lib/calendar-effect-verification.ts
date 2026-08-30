import 'server-only'
import { listZohoCalendarEvents, type BookingEventInput } from './zoho-calendar'
import {
  type EffectObservation,
  type EffectVerificationResult,
  type ExecutionReceipt,
} from './effect-verification'
import { verifyAndPersistEffect } from './effect-verification-store'

export async function verifyCalendarUpsert(args: {
  workspaceId: string
  bookingId: string
  eventId: string
  booking: BookingEventInput
  requestedAt: string
  execution: ExecutionReceipt
}): Promise<EffectVerificationResult> {
  const effect = 'zoho_calendar_upsert'
  const idempotencyKey = `zoho_calendar:${args.bookingId}:upsert`
  const expected = {
    uid: args.eventId,
    startDate: args.booking.bookingDate,
    startTime: args.booking.bookingTime.slice(0, 8),
    durationMinutes: args.booking.durationMinutes,
  }

  let observation: EffectObservation
  try {
    const events = await listZohoCalendarEvents(
      args.workspaceId,
      args.booking.bookingDate,
      args.booking.bookingDate
    )
    const event = events.find(e => e.uid === args.eventId)
    observation = {
      workspaceId: args.workspaceId,
      effect,
      observedAt: new Date().toISOString(),
      source: 'zoho_calendar_list',
      provenanceRef: event ? `zoho_event:${event.uid}` : `zoho_event:${args.eventId}:not_found`,
      state: event
        ? {
            uid: event.uid,
            startDate: event.startDate,
            startTime: event.startTime,
            durationMinutes: event.durationMinutes,
          }
        : { uid: null, absent: true },
    }
  } catch (err) {
    observation = {
      workspaceId: args.workspaceId,
      effect,
      observedAt: new Date().toISOString(),
      source: 'zoho_calendar_list',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  return verifyAndPersistEffect({
    workspaceId: args.workspaceId,
    effectId: `${args.bookingId}:calendar:upsert`,
    effect,
    idempotencyKey,
    expectedState: expected,
    authorityRef: `booking_workspace:${args.bookingId}`,
    requestedAt: args.requestedAt,
    execution: args.execution,
    observation,
  })
}

export async function verifyCalendarDelete(args: {
  workspaceId: string
  bookingId: string
  eventId: string
  bookingDate: string
  requestedAt: string
  execution: ExecutionReceipt
}): Promise<EffectVerificationResult> {
  const effect = 'zoho_calendar_delete'
  const idempotencyKey = `zoho_calendar:${args.bookingId}:delete`
  const expected = { absent: true }

  let observation: EffectObservation
  try {
    const events = await listZohoCalendarEvents(args.workspaceId, args.bookingDate, args.bookingDate)
    const exists = events.some(e => e.uid === args.eventId)
    observation = {
      workspaceId: args.workspaceId,
      effect,
      observedAt: new Date().toISOString(),
      source: 'zoho_calendar_list',
      provenanceRef: `zoho_event:${args.eventId}:${exists ? 'present' : 'absent'}`,
      state: { absent: !exists },
    }
  } catch (err) {
    observation = {
      workspaceId: args.workspaceId,
      effect,
      observedAt: new Date().toISOString(),
      source: 'zoho_calendar_list',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  return verifyAndPersistEffect({
    workspaceId: args.workspaceId,
    effectId: `${args.bookingId}:calendar:delete`,
    effect,
    idempotencyKey,
    expectedState: expected,
    authorityRef: `booking_workspace:${args.bookingId}`,
    requestedAt: args.requestedAt,
    execution: args.execution,
    observation,
  })
}
