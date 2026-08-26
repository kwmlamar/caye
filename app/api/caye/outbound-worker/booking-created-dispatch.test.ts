import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * bookingCreatedDispatchCancelReason — the dispatch-time re-check that
 * closes the quiet-hours race (2026-08-26 Autumn McNeill incident, PR #135
 * review requirement 6): a booking_created row can sit queued for hours
 * (deferred past quiet hours), during which the operator may go handle the
 * conversation directly. This must catch that regardless of whether the
 * queued row is the FIRST notification for this booking or a LATER one
 * enqueued after a genuine material state change (the idempotency fix) —
 * the check re-fetches the booking fresh every time and isn't keyed off
 * which "generation" of row it's checking.
 */

interface Row {
  [key: string]: unknown
}

let BOOKING: Row | null = null

const { hasOperatorParticipatedInConversation } = vi.hoisted(() => ({
  hasOperatorParticipatedInConversation: vi.fn(),
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'bookings') throw new Error(`unexpected table: ${table}`)
      const chain: Record<string, unknown> = {}
      const self = () => chain
      Object.assign(chain, {
        select: self,
        eq: self,
        maybeSingle: () => Promise.resolve({ data: BOOKING, error: null }),
      })
      return chain
    },
  }),
}))
vi.mock('@/lib/whatsapp/operator-participation', () => ({ hasOperatorParticipatedInConversation }))

// The rest of route.ts's module-level imports are heavy (Meta send stack,
// cron logging, etc.) — stub every one so importing the module for this one
// exported function doesn't require standing up the whole worker.
vi.mock('@/lib/whatsapp/outbound', () => ({
  sendFreeFormWhatsApp: vi.fn(),
  sendTemplateWhatsApp: vi.fn(),
}))
vi.mock('@/lib/whatsapp/window', () => ({ isWhatsAppWindowOpen: vi.fn() }))
vi.mock('@/lib/whatsapp/email-fallback', () => ({ emailFallbackForFailedPing: vi.fn() }))
vi.mock('@/lib/operator-identity', () => ({ resolveOperatorByPhone: vi.fn() }))
vi.mock('@/lib/whatsapp/schedule', () => ({
  loadScheduleConfig: vi.fn(),
  nextDigestTime: vi.fn(),
  localDayOfWeek: vi.fn(),
}))
vi.mock('@/lib/cron-run-log', () => ({ recordCronRun: vi.fn(), checkStaleCronsAndAlert: vi.fn() }))
vi.mock('@/lib/whatsapp/founder-alert', () => ({ alertFounderOfDeliveryFailure: vi.fn() }))
vi.mock('@/lib/email/founder-mailer', () => ({ sendFounderAlertEmail: vi.fn() }))
vi.mock('@/lib/whatsapp/delivery-errors', () => ({ extractErrorCode: vi.fn() }))
vi.mock('@/lib/whatsapp/template-sync', () => ({ resyncTemplatesAfterParamMismatch: vi.fn() }))
vi.mock('@/lib/pending-operations-worker', () => ({ drainPendingOperationsSafely: vi.fn() }))
vi.mock('@/lib/owner-attention', () => ({ markAttentionNotified: vi.fn() }))

import { bookingCreatedDispatchCancelReason, type QueueRow } from './route'

function row(over: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 'q1',
    workspace_id: 'ws-bimini',
    kind: 'booking_created',
    conversation_id: 'conv-autumn',
    payload: { bookingId: 'booking-autumn', guest: 'Autumn McNeill' },
    scheduled_for: '2026-08-26T11:00:00Z',
    failure_count: 0,
    idempotency_key: 'booking-autumn-fp1',
    ...over,
  }
}

function pendingBooking(over: Partial<Row> = {}): Row {
  return {
    status: 'pending',
    cancelled_at: null,
    conversation_id: 'conv-autumn',
    created_at: '2026-08-26T01:40:13Z',
    updated_at: '2026-08-26T01:45:06Z',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  BOOKING = pendingBooking()
})

describe('bookingCreatedDispatchCancelReason', () => {
  it('cancels when the operator has since handled the conversation directly', async () => {
    hasOperatorParticipatedInConversation.mockResolvedValue(true)
    const reason = await bookingCreatedDispatchCancelReason(row())
    expect(reason).toBe('operator handled directly')
  })

  it('proceeds (returns null) when no participation is found', async () => {
    hasOperatorParticipatedInConversation.mockResolvedValue(false)
    const reason = await bookingCreatedDispatchCancelReason(row())
    expect(reason).toBeNull()
  })

  it('cancels when the booking was cancelled before the send fired', async () => {
    BOOKING = pendingBooking({ status: 'cancelled', cancelled_at: '2026-08-26T05:00:00Z' })
    const reason = await bookingCreatedDispatchCancelReason(row())
    expect(reason).toBe('booking cancelled before send')
    expect(hasOperatorParticipatedInConversation).not.toHaveBeenCalled()
  })

  it('cancels when the booking is gone entirely', async () => {
    BOOKING = null
    const reason = await bookingCreatedDispatchCancelReason(row())
    expect(reason).toBe('booking cancelled before send')
  })

  it('re-fetches the booking fresh rather than trusting the queued payload — catches a LATER-generation row the same way as the first', async () => {
    // Simulates the idempotency-fix scenario: this queue row was enqueued
    // for a materially different (confirmed) state than the booking
    // started at, with its own distinct idempotency key — the dispatch
    // check doesn't care which generation it is, only what's true now.
    BOOKING = pendingBooking({ status: 'confirmed', payment_confirmed_at: '2026-08-27T10:00:00Z' })
    hasOperatorParticipatedInConversation.mockResolvedValue(true)
    const reason = await bookingCreatedDispatchCancelReason(
      row({ idempotency_key: 'booking-autumn-fp2-confirmed-paid' })
    )
    expect(reason).toBe('operator handled directly')
  })

  it('prefers the booking row\'s own conversation_id over the queued row\'s', async () => {
    BOOKING = pendingBooking({ conversation_id: 'conv-fresh' })
    hasOperatorParticipatedInConversation.mockResolvedValue(false)
    await bookingCreatedDispatchCancelReason(row({ conversation_id: 'conv-stale' }))
    expect(hasOperatorParticipatedInConversation).toHaveBeenCalledWith('conv-fresh', expect.any(String))
  })

  it('anchors the participation check to booking.updated_at, not the queue row\'s own timestamps', async () => {
    hasOperatorParticipatedInConversation.mockResolvedValue(false)
    await bookingCreatedDispatchCancelReason(row())
    expect(hasOperatorParticipatedInConversation).toHaveBeenCalledWith('conv-autumn', '2026-08-26T01:45:06Z')
  })

  it('is a no-op when the row carries no bookingId', async () => {
    const reason = await bookingCreatedDispatchCancelReason(row({ payload: {} }))
    expect(reason).toBeNull()
    expect(hasOperatorParticipatedInConversation).not.toHaveBeenCalled()
  })
})
