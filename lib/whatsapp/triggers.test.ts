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
// fingerprint is the REAL implementation (not mocked) — triggers.ts's
// idempotencyKey fix depends on it being the exact same hash function the
// owner-attention gate itself uses, so the test has to exercise the real
// thing, not a stub that would hide a drift between the two.
vi.mock('@/lib/owner-attention', async () => {
  const actual = await vi.importActual<typeof import('@/lib/owner-attention')>('@/lib/owner-attention')
  return {
    ...actual,
    markAttentionPending,
  }
})
vi.mock('./schedule', () => ({
  loadScheduleConfig: () => Promise.resolve({ timezone: 'America/New_York', digestDays: [0, 1, 2, 3, 4, 5, 6] }),
  inQuietHours: () => false,
  nextDigestTime: () => new Date('2026-08-26T11:00:00Z'),
}))
vi.mock('./urgency', () => ({ classifyHoldUrgency: () => 'routine' }))

import { enqueueBookingCreated } from './triggers'
import { fingerprint } from '@/lib/owner-attention'

/** Same shape as the fingerprintParts array triggers.ts builds — kept here
 *  so tests can compute the SAME hash independently and assert against it,
 *  without hard-coding a specific hash string that would silently stop
 *  meaning anything the moment the real array's field order changed. */
function bookingFingerprintParts(b: Row): unknown[] {
  return [
    b.status,
    b.payment_confirmed_at,
    b.payment_link_sent_at,
    b.cancelled_at,
    b.booking_date,
    b.booking_time,
    b.number_of_people,
  ]
}

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
    // Deliberately just a conversationId (PR #135 review, second finding)
    // — the evidence window itself is derived inside the gate from
    // caye_owner_attention.first_state_fingerprint, never from a
    // caller-supplied timestamp; see operator-notification-gate.test.ts.
    expect(call.operatorParticipationCheck).toEqual({ conversationId: 'conv-autumn' })
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

describe('enqueueBookingCreated — idempotency identity is state-derived (PR #135 review fix)', () => {
  // enqueueOutbound is permanently idempotent on idempotency_key (see its
  // own doc comment) — a bare `booking-${bookingId}` key meant the SECOND
  // real notification for a booking (a genuine status/payment transition)
  // could pass the owner-attention gate and then silently never enqueue,
  // because a row already existed under that same key from the first
  // notification. This mock simulates that real uniqueness constraint so
  // these tests fail the same way production would have.
  let usedKeys: Set<string>

  beforeEach(() => {
    usedKeys = new Set()
    enqueueOutbound.mockImplementation((args: { idempotencyKey: string }) => {
      if (usedKeys.has(args.idempotencyKey)) return Promise.resolve(null)
      usedKeys.add(args.idempotencyKey)
      return Promise.resolve({ id: `queue-${usedKeys.size}` })
    })
    decideOperatorNotification.mockResolvedValue({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
  })

  it('1 — same booking + same material state twice => one queue row (duplicate protection preserved)', async () => {
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })

    expect(enqueueOutbound).toHaveBeenCalledTimes(2)
    const [key1] = [enqueueOutbound.mock.calls[0][0].idempotencyKey]
    const [key2] = [enqueueOutbound.mock.calls[1][0].idempotencyKey]
    expect(key1).toBe(key2) // same key both times — the second insert is the one the DB would reject
    expect(markAttentionPending).toHaveBeenCalledTimes(1) // only the row that actually got created
  })

  it('2 — pending booking notified, then confirmed => second eligible notification actually enqueues', async () => {
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })
    BOOKING = autumnBooking({ status: 'confirmed' })
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })

    expect(enqueueOutbound).toHaveBeenCalledTimes(2)
    const key1 = enqueueOutbound.mock.calls[0][0].idempotencyKey
    const key2 = enqueueOutbound.mock.calls[1][0].idempotencyKey
    expect(key1).not.toBe(key2)
    expect(markAttentionPending).toHaveBeenCalledTimes(2) // BOTH rows actually got created
  })

  it('3 — confirmed then payment confirmed => second eligible notification (payment is a fingerprinted field)', async () => {
    BOOKING = autumnBooking({ status: 'confirmed' })
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })
    BOOKING = autumnBooking({ status: 'confirmed', payment_confirmed_at: '2026-08-27T10:00:00Z' })
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })

    expect(enqueueOutbound).toHaveBeenCalledTimes(2)
    expect(markAttentionPending).toHaveBeenCalledTimes(2)
  })

  it('4 — an unrelated updated_at change alone does not enqueue a second notification', async () => {
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })
    // Same status/payment/date/time/party — only updated_at moved (e.g. an
    // unrelated column got touched, or a re-sync bumped the row).
    BOOKING = autumnBooking({ updated_at: '2026-08-26T09:00:00Z' })
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })

    const key1 = enqueueOutbound.mock.calls[0][0].idempotencyKey
    const key2 = enqueueOutbound.mock.calls[1][0].idempotencyKey
    expect(key1).toBe(key2) // updated_at is deliberately NOT in fingerprintParts
    expect(markAttentionPending).toHaveBeenCalledTimes(1)
  })

  it('5 — a state suppressed as operator-aware, followed by a real material change, lets the later state notify', async () => {
    decideOperatorNotification.mockResolvedValueOnce({
      outcome: 'SUPPRESS_OPERATOR_AWARE',
      attentionItemId: 'a1',
      isMaterialChange: false,
    })
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })
    expect(enqueueOutbound).not.toHaveBeenCalled() // suppressed — nothing queued at all yet

    decideOperatorNotification.mockResolvedValueOnce({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: true })
    BOOKING = autumnBooking({ status: 'confirmed', payment_confirmed_at: '2026-08-27T10:00:00Z' })
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })

    expect(enqueueOutbound).toHaveBeenCalledTimes(1)
    expect(markAttentionPending).toHaveBeenCalledTimes(1)
  })

  it('the idempotency key hashes the exact same fingerprintParts the owner-attention gate fingerprints', async () => {
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })
    const key = enqueueOutbound.mock.calls[0][0].idempotencyKey as string
    const expectedFp = fingerprint(bookingFingerprintParts(autumnBooking()))
    expect(key).toBe(`booking-booking-autumn-${expectedFp}`)
  })

  it('the queued payload also carries stateFingerprint, matching the idempotency key exactly — the outbound worker\'s dispatch-time staleness check depends on this', async () => {
    await enqueueBookingCreated({ workspaceId: 'ws-bimini', conversationId: 'conv-autumn', bookingId: 'booking-autumn' })
    const { idempotencyKey, payload } = enqueueOutbound.mock.calls[0][0]
    const expectedFp = fingerprint(bookingFingerprintParts(autumnBooking()))
    expect(payload.stateFingerprint).toBe(expectedFp)
    expect(idempotencyKey).toBe(`booking-booking-autumn-${expectedFp}`)
  })
})
