import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * enqueueBookingCreated (2026-08-26, Autumn McNeill incident) — tests the
 * trigger's OWN logic: what it fetches, what it decides to say, and what it
 * passes to decideOperatorNotification. The gate's own suppression/send
 * decision mechanics are covered exhaustively in
 * operator-notification-gate.test.ts; here decideOperatorNotification is
 * mocked so these tests stay about triggers.ts's contract with it.
 */

interface Row {
  [key: string]: unknown
}

let BOOKING: Row | null = null
let WORKSPACE_CONFIG: Row | null = { whatsapp_outbound_enabled: true, operator_whatsapp_verified_at: '2026-06-01T00:00:00Z' }

const { decideOperatorNotification, enqueueOutbound, markAttentionPending } = vi.hoisted(() => ({
  decideOperatorNotification: vi.fn(),
  enqueueOutbound: vi.fn(),
  markAttentionPending: vi.fn(),
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      Object.assign(chain, {
        select: self,
        eq: self,
        maybeSingle: () =>
          Promise.resolve({
            data: table === 'bookings' ? BOOKING : table === 'workspace_ai_config' ? WORKSPACE_CONFIG : null,
            error: null,
          }),
      })
      return chain
    },
  }),
}))

vi.mock('./operator-notification-gate', () => ({ decideOperatorNotification }))
vi.mock('./outbound', () => ({ enqueueOutbound }))
vi.mock('@/lib/owner-attention', () => ({
  markAttentionPending,
  SUBJECT_CONVERSATION: 'conversation',
}))
vi.mock('./schedule', () => ({
  loadScheduleConfig: () => Promise.resolve({ timezone: 'America/New_York', digestDays: [0, 1, 2, 3, 4, 5, 6] }),
  inQuietHours: () => false,
  nextDigestTime: () => new Date('2026-08-26T11:00:00Z'),
}))
vi.mock('./urgency', () => ({ classifyHoldUrgency: () => 'routine' }))

import { enqueueBookingCreated } from './triggers'

function autumnBooking(over: Partial<Row> = {}): Row {
  return {
    conversation_id: 'conv-autumn',
    customer_name: 'Autumn McNeill',
    booking_date: '2026-09-05',
    booking_time: '09:00:00',
    number_of_people: 2,
    status: 'pending',
    payment_confirmed_at: null,
    payment_link_sent_at: null,
    cancelled_at: null,
    created_at: '2026-08-26T01:40:13Z',
    updated_at: '2026-08-26T01:45:06Z',
    service: { name: 'North Bimini Heritage Tour' },
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  BOOKING = autumnBooking()
  WORKSPACE_CONFIG = { whatsapp_outbound_enabled: true, operator_whatsapp_verified_at: '2026-06-01T00:00:00Z' }
  enqueueOutbound.mockResolvedValue({ id: 'queue-1' })
})

describe('enqueueBookingCreated — Autumn McNeill regression (2026-08-26)', () => {
  it('A — never enqueues a WhatsApp send when the gate reports the operator already handled it', async () => {
    decideOperatorNotification.mockResolvedValue({
      outcome: 'SUPPRESS_OPERATOR_AWARE',
      attentionItemId: 'a1',
      isMaterialChange: false,
    })

    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })

    expect(enqueueOutbound).not.toHaveBeenCalled()
    expect(markAttentionPending).not.toHaveBeenCalled()
  })

  it('routes through the SAME owner-attention gate every other proactive producer uses, with an operator-participation check attached', async () => {
    decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })

    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })

    expect(decideOperatorNotification).toHaveBeenCalledTimes(1)
    const call = decideOperatorNotification.mock.calls[0][0]
    expect(call.subjectType).toBe('booking')
    expect(call.subjectId).toBe('booking-autumn')
    expect(call.conversationId).toBe('conv-autumn')
    expect(call.operatorParticipationCheck).toEqual({
      conversationId: 'conv-autumn',
      stateSinceISO: '2026-08-26T01:45:06Z', // booking.updated_at
    })
  })

  it('prefers the booking row\'s own conversation_id over the caller-supplied one', async () => {
    decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-caller-guess', bookingId: 'booking-autumn' })
    expect(decideOperatorNotification.mock.calls[0][0].conversationId).toBe('conv-autumn')
  })

  it('omits operatorParticipationCheck entirely when no conversation can be resolved', async () => {
    BOOKING = autumnBooking({ conversation_id: null })
    decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: null, bookingId: 'booking-autumn' })
    expect(decideOperatorNotification.mock.calls[0][0].operatorParticipationCheck).toBeUndefined()
  })

  it('C — a pending booking is never described as "Just booked" or "confirmed"', async () => {
    decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })

    const call = decideOperatorNotification.mock.calls[0][0]
    expect(call.title).not.toMatch(/just booked/i)
    expect(call.title).toContain('New pending booking')

    const queuedPayload = enqueueOutbound.mock.calls[0][0].payload
    expect(queuedPayload.stateLabel).toBe('New pending booking')
    expect(JSON.stringify(queuedPayload)).not.toMatch(/just booked/i)
  })

  it('C — a confirmed, paid booking is described honestly, not "just booked" either', async () => {
    BOOKING = autumnBooking({ status: 'confirmed', payment_confirmed_at: '2026-08-27T10:00:00Z' })
    decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })

    const queuedPayload = enqueueOutbound.mock.calls[0][0].payload
    expect(queuedPayload.stateLabel).toBe('Booking confirmed & paid')
  })

  it('a genuinely new, un-participated booking still sends and stamps the attention item pending', async () => {
    decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })

    expect(enqueueOutbound).toHaveBeenCalledTimes(1)
    expect(enqueueOutbound.mock.calls[0][0].kind).toBe('booking_created')
    expect(markAttentionPending).toHaveBeenCalledWith({
      workspaceId: 'ws-bimini',
      subjectType: 'booking',
      subjectId: 'booking-autumn',
      queueId: 'queue-1',
    })
  })

  it('does nothing at all when the ping is disabled for the workspace', async () => {
    WORKSPACE_CONFIG = { whatsapp_outbound_enabled: false, operator_whatsapp_verified_at: null }
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })
    expect(decideOperatorNotification).not.toHaveBeenCalled()
    expect(enqueueOutbound).not.toHaveBeenCalled()
  })

  it('does nothing when the booking is gone by the time the trigger fires', async () => {
    BOOKING = null
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-gone' })
    expect(decideOperatorNotification).not.toHaveBeenCalled()
    expect(enqueueOutbound).not.toHaveBeenCalled()
  })

  it('every other suppressed outcome also results in no send (B — no-op proactive suppression)', async () => {
    for (const outcome of ['SUPPRESS_NO_CHANGE', 'SUPPRESS_RECENTLY_NOTIFIED', 'RESOLVED_NO_NOTIFICATION'] as const) {
      enqueueOutbound.mockClear()
      decideOperatorNotification.mockResolvedValue({ outcome, attentionItemId: 'a1', isMaterialChange: false })
      await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })
      expect(enqueueOutbound).not.toHaveBeenCalled()
    }
  })
})
