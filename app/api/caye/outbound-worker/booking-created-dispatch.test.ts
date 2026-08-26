import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * bookingCreatedDispatchCancelReason — the dispatch-time re-check that
 * closes the quiet-hours race (2026-08-26 Autumn McNeill incident). A
 * booking_created row can sit queued for hours (deferred past quiet
 * hours), during which either the operator may go handle the conversation
 * directly, or the booking's authoritative state may move on entirely
 * (PR #135 review, third finding — the "stale queued state" adversarial
 * question). This function is the one place both get caught, right before
 * the send actually goes out, regardless of whether the queued row is the
 * FIRST notification for this booking or a LATER one enqueued after a
 * genuine material state change (the idempotency fix) — it re-fetches the
 * booking fresh every time and isn't keyed off which "generation" it is.
 */

interface Row {
  [key: string]: unknown
}

let BOOKING: Row | null = null

const { decideOperatorNotification } = vi.hoisted(() => ({
  decideOperatorNotification: vi.fn(),
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
vi.mock('@/lib/whatsapp/operator-notification-gate', () => ({ decideOperatorNotification }))
// The status/payment -> label mapping is triggers.ts's own concern and is
// covered by ping-log-body.test.ts's "honest state language" suite —
// stubbed here to a simple, inspectable value so this file stays about
// dispatch-time cancellation, not label wording.
vi.mock('@/lib/whatsapp/triggers', () => ({
  bookingStateLabel: (status: string, paid: string | null) => (paid ? 'STATE:paid' : `STATE:${status}`),
}))

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
vi.mock('@/lib/owner-attention', () => ({
  markAttentionNotified: vi.fn(),
  fingerprint: (parts: unknown[]) => JSON.stringify(parts), // deterministic stand-in, not the real hash
}))

import { bookingCreatedDispatchCancelReason, type QueueRow } from './route'

function pendingBookingFields(over: Partial<Row> = {}): Row {
  return {
    status: 'pending',
    payment_confirmed_at: null,
    payment_link_sent_at: null,
    cancelled_at: null,
    booking_date: '2026-09-05',
    booking_time: '09:00:00',
    number_of_people: 2,
    ...over,
  }
}

/** Same field order bookingCreatedDispatchCancelReason fingerprints. */
function fp(fields: Row): string {
  return JSON.stringify([
    fields.status,
    fields.payment_confirmed_at,
    fields.payment_link_sent_at,
    fields.cancelled_at,
    fields.booking_date,
    fields.booking_time,
    fields.number_of_people,
  ])
}

function pendingBooking(over: Partial<Row> = {}): Row {
  return {
    customer_name: 'Autumn McNeill',
    conversation_id: 'conv-autumn',
    ...pendingBookingFields(),
    ...over,
  }
}

function row(over: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 'q1',
    workspace_id: 'ws-bimini',
    kind: 'booking_created',
    conversation_id: 'conv-autumn',
    payload: { bookingId: 'booking-autumn', guest: 'Autumn McNeill', stateFingerprint: fp(pendingBookingFields()) },
    scheduled_for: '2026-08-26T11:00:00Z',
    failure_count: 0,
    idempotency_key: 'booking-autumn-fp1',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  BOOKING = pendingBooking()
})

describe('bookingCreatedDispatchCancelReason', () => {
  it('cancels when the operator has since handled the conversation directly', async () => {
    decideOperatorNotification.mockResolvedValue({ outcome: 'SUPPRESS_OPERATOR_AWARE', attentionItemId: 'a1', isMaterialChange: false })
    const reason = await bookingCreatedDispatchCancelReason(row())
    expect(reason).toBe('operator handled directly')
  })

  it('proceeds (returns null) when the gate says send', async () => {
    decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
    const reason = await bookingCreatedDispatchCancelReason(row())
    expect(reason).toBeNull()
  })

  describe('SEND-vs-SUPPRESS invariant — the gate is authoritative at dispatch time, not just for operator-awareness (PR #135 review, fourth finding)', () => {
    // The bug: an earlier version only cancelled on SUPPRESS_OPERATOR_AWARE
    // and let every other non-send outcome fall through and dispatch
    // anyway — including SUPPRESS_NO_CHANGE (another producer already told
    // the operator about this exact state while the row sat queued),
    // SUPPRESS_RECENTLY_NOTIFIED (a cooldown now applies), and
    // RESOLVED_NO_NOTIFICATION (the attention item was resolved out from
    // under it). Only a genuine SEND_* outcome may proceed.
    it('1 — SUPPRESS_NO_CHANGE (another notifier already told the operator about this state while queued) cancels, no duplicate send', async () => {
      decideOperatorNotification.mockResolvedValue({ outcome: 'SUPPRESS_NO_CHANGE', attentionItemId: 'a1', isMaterialChange: false })
      const reason = await bookingCreatedDispatchCancelReason(row())
      expect(reason).toBe('operator already informed / no material change')
    })

    it('2 — SUPPRESS_RECENTLY_NOTIFIED cancels', async () => {
      decideOperatorNotification.mockResolvedValue({ outcome: 'SUPPRESS_RECENTLY_NOTIFIED', attentionItemId: 'a1', isMaterialChange: false })
      const reason = await bookingCreatedDispatchCancelReason(row())
      expect(reason).toBe('notification no longer warranted')
    })

    it('3 — the attention item becoming resolved before dispatch (RESOLVED_NO_NOTIFICATION) cancels', async () => {
      decideOperatorNotification.mockResolvedValue({ outcome: 'RESOLVED_NO_NOTIFICATION', attentionItemId: 'a1', isMaterialChange: false })
      const reason = await bookingCreatedDispatchCancelReason(row())
      expect(reason).toBe('attention item resolved')
    })

    it('4 — SUPPRESS_OPERATOR_AWARE still cancels as before', async () => {
      decideOperatorNotification.mockResolvedValue({ outcome: 'SUPPRESS_OPERATOR_AWARE', attentionItemId: 'a1', isMaterialChange: false })
      const reason = await bookingCreatedDispatchCancelReason(row())
      expect(reason).toBe('operator handled directly')
    })

    it('5 — SEND_NEW proceeds', async () => {
      decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
      const reason = await bookingCreatedDispatchCancelReason(row())
      expect(reason).toBeNull()
    })

    it('6 — SEND_REMINDER proceeds', async () => {
      decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_REMINDER', attentionItemId: 'a1', isMaterialChange: false })
      const reason = await bookingCreatedDispatchCancelReason(row())
      expect(reason).toBeNull()
    })

    it('SEND_CRITICAL_ESCALATION proceeds too', async () => {
      decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_CRITICAL_ESCALATION', attentionItemId: 'a1', isMaterialChange: false })
      const reason = await bookingCreatedDispatchCancelReason(row())
      expect(reason).toBeNull()
    })
  })

  it('cancels when the booking was cancelled before the send fired', async () => {
    BOOKING = pendingBooking({ status: 'cancelled', cancelled_at: '2026-08-26T05:00:00Z' })
    const reason = await bookingCreatedDispatchCancelReason(row())
    expect(reason).toBe('booking cancelled before send')
    expect(decideOperatorNotification).not.toHaveBeenCalled()
  })

  it('cancels when the booking is gone entirely', async () => {
    BOOKING = null
    const reason = await bookingCreatedDispatchCancelReason(row())
    expect(reason).toBe('booking cancelled before send')
  })

  it('re-fetches the booking fresh rather than trusting the queued payload — protects a LATER-generation row the same way as the first', async () => {
    // Simulates the idempotency-fix scenario: this queue row was enqueued
    // for a materially different (confirmed+paid) state than a pending
    // booking, with its own distinct idempotency key AND matching
    // stateFingerprint — the dispatch check doesn't care which generation
    // it is, only that the payload still matches current truth.
    const confirmedPaidFields = pendingBookingFields({ status: 'confirmed', payment_confirmed_at: '2026-08-27T10:00:00Z' })
    BOOKING = pendingBooking(confirmedPaidFields)
    decideOperatorNotification.mockResolvedValue({ outcome: 'SUPPRESS_OPERATOR_AWARE', attentionItemId: 'a1', isMaterialChange: false })
    const reason = await bookingCreatedDispatchCancelReason(
      row({
        idempotency_key: 'booking-autumn-fp2-confirmed-paid',
        payload: { bookingId: 'booking-autumn', guest: 'Autumn McNeill', stateFingerprint: fp(confirmedPaidFields) },
      })
    )
    expect(reason).toBe('operator handled directly')
  })

  describe('stale-state guard (PR #135 review, third finding + adversarial question)', () => {
    it('7 — cancels as stale when the booking has materially moved on since the row was queued, BEFORE the gate is ever evaluated — never sends text describing an old state', async () => {
      // Row was queued while pending; by dispatch time the booking is
      // confirmed+paid. The queued payload's stateFingerprint (computed at
      // enqueue time from the PENDING fields) no longer matches current
      // truth.
      BOOKING = pendingBooking({ status: 'confirmed', payment_confirmed_at: '2026-08-27T10:00:00Z' })
      const reason = await bookingCreatedDispatchCancelReason(row()) // row()'s payload.stateFingerprint is the PENDING fp
      expect(reason).toBe('booking state changed before send')
      // The stale check runs BEFORE the gate — never even asks about
      // operator participation or any other gate outcome for a row that's
      // going to be cancelled as stale regardless of the answer.
      expect(decideOperatorNotification).not.toHaveBeenCalled()
    })

    it('proceeds normally when the payload still matches the current state exactly', async () => {
      decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
      const reason = await bookingCreatedDispatchCancelReason(row()) // BOOKING is still pending, matches row()'s payload
      expect(reason).toBeNull()
    })

    it('does not treat a legacy row with no stateFingerprint in its payload as unconditionally stale', async () => {
      BOOKING = pendingBooking({ status: 'confirmed', payment_confirmed_at: '2026-08-27T10:00:00Z' })
      decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
      const reason = await bookingCreatedDispatchCancelReason(
        row({ payload: { bookingId: 'booking-autumn', guest: 'Autumn McNeill' } }) // no stateFingerprint at all
      )
      expect(reason).toBeNull()
      expect(decideOperatorNotification).toHaveBeenCalledTimes(1)
    })
  })

  it('prefers the booking row\'s own conversation_id over the queued row\'s', async () => {
    BOOKING = pendingBooking({ conversation_id: 'conv-fresh' })
    decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
    await bookingCreatedDispatchCancelReason(row({ conversation_id: 'conv-stale' }))
    expect(decideOperatorNotification.mock.calls[0][0].conversationId).toBe('conv-fresh')
  })

  it('re-runs the SAME owner-attention gate enqueueBookingCreated used, with the SAME subject identity and an operator-participation check', async () => {
    decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
    await bookingCreatedDispatchCancelReason(row())
    const call = decideOperatorNotification.mock.calls[0][0]
    expect(call.subjectType).toBe('booking')
    expect(call.subjectId).toBe('booking-autumn')
    expect(call.priority).toBe('awareness')
    expect(call.operatorParticipationCheck).toEqual({ conversationId: 'conv-autumn' })
  })

  it('is a no-op when the row carries no bookingId', async () => {
    const reason = await bookingCreatedDispatchCancelReason(row({ payload: {} }))
    expect(reason).toBeNull()
    expect(decideOperatorNotification).not.toHaveBeenCalled()
  })
})
