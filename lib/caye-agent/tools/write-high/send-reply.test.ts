import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const mocks = vi.hoisted(() => ({
  dispatchOperatorReply: vi.fn(async () => ({ channelType: 'email', messageId: 'msg-1' })),
  resolveOpenEscalations: vi.fn(async () => undefined),
}))

vi.mock('@/lib/whatsapp/channel-dispatch', () => ({ dispatchOperatorReply: mocks.dispatchOperatorReply }))
vi.mock('../write-low/_guards', () => ({
  assertConversationOwnedByWorkspace: vi.fn(async () => ({ ok: true })),
  resolveOpenEscalations: mocks.resolveOpenEscalations,
}))

// Sonja Pettus's booking_time as it stands in the fake DB — mutated per
// test to simulate "not yet rescheduled" vs "actually rescheduled."
let fakeBookingTime: string | null = '09:00:00'
let fakeBookingRows: Array<{ booking_time: string | null }> | null = null // null = use fakeBookingTime as a single row

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'unified_messages') {
        const query = {
          eq: () => query,
          order: () => query,
          limit: async () => ({ data: [{ content: 'The pickup is at 9:00 AM.' }] }),
        }
        return { select: () => query }
      }
      if (table === 'unified_conversations') {
        return { update: () => ({ eq: async () => ({ error: null }) }) }
      }
      if (table === 'bookings') {
        const query = {
          eq: () => query,
          neq: () => query,
          then: (resolve: (v: { data: Array<{ booking_time: string | null }> }) => void) =>
            resolve({ data: fakeBookingRows ?? [{ booking_time: fakeBookingTime }] }),
        }
        return { select: () => query }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { sendReply } from './send-reply'

describe('send_reply owner-confirmed logistics', () => {
  beforeEach(() => {
    mocks.dispatchOperatorReply.mockClear()
    fakeBookingTime = '09:00:00'
    fakeBookingRows = null
  })

  it('sends an owner-approved time change even when the prior customer thread has the old time', async () => {
    const result = await sendReply.execute(
      { conversation_id: 'conv-1', body: 'Your pickup time has been adjusted to 9:30 AM.' },
      { workspaceId: 'ws-1', callerRole: 'owner', operatorId: 1, requestId: 'confirmed-turn' }
    )

    expect(result.ok).toBe(true)
    expect(mocks.dispatchOperatorReply).toHaveBeenCalledWith(
      'conv-1',
      'Your pickup time has been adjusted to 9:30 AM.',
      'caye-dashboard'
    )
  })

  it('still blocks an unapproved logistics invention', async () => {
    const result = await sendReply.execute(
      { conversation_id: 'conv-1', body: 'Your pickup time has been adjusted to 9:30 AM.' },
      { workspaceId: 'ws-1', callerRole: 'staff', operatorId: null, requestId: 'unapproved-turn' }
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error_code : null).toBe('UNGROUNDED_LOGISTICS_TIME')
    expect(mocks.dispatchOperatorReply).not.toHaveBeenCalled()
  })
})

describe('2026-08-26 Sonja Pettus incident regression — UNGROUNDED_BOOKING_TIME', () => {
  beforeEach(() => {
    mocks.dispatchOperatorReply.mockClear()
    fakeBookingTime = '09:00:00'
    fakeBookingRows = null
  })

  it('THE INCIDENT: blocks telling the customer the tour is at 10am while the booking record still says 09:00 — even for an owner-approved send', async () => {
    fakeBookingTime = '09:00:00'
    const result = await sendReply.execute(
      {
        conversation_id: 'conv-sonja',
        body: 'We wanted to reach out to let you know that we would like to adjust your tour start time to 10:00 a.m. rather than 9:00 a.m.',
      },
      { workspaceId: 'ws-1', callerRole: 'owner', operatorId: 1, requestId: 'sonja-turn-1' }
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error_code : null).toBe('UNGROUNDED_BOOKING_TIME')
    expect(result.ok === false ? result.error : '').toMatch(/reschedule_booking/)
    expect(mocks.dispatchOperatorReply).not.toHaveBeenCalled()
  })

  it('THE FIX: allows the identical message once reschedule_booking has actually updated the record to 10:00', async () => {
    fakeBookingTime = '10:00:00'
    const result = await sendReply.execute(
      {
        conversation_id: 'conv-sonja',
        body: 'Tour Start Time: 10:00 a.m. (please note the updated time from 9:00 a.m.)',
      },
      { workspaceId: 'ws-1', callerRole: 'owner', operatorId: 1, requestId: 'sonja-turn-2' }
    )

    expect(result.ok).toBe(true)
    expect(mocks.dispatchOperatorReply).toHaveBeenCalledTimes(1)
  })

  it('blocks the payment-confirmation-style bare-24h phrasing too, at 09:00 while the record has already moved to 10:00', async () => {
    // Mirrors the real second half of the incident: a payment confirmation
    // sent seconds after the "10am" message still read the stale 9:00 back.
    fakeBookingTime = '10:00:00'
    const result = await sendReply.execute(
      {
        conversation_id: 'conv-sonja',
        body: "Thanks so much — we've received your payment for your tour on Wednesday, August 26 at 09:00. You're all set!",
      },
      { workspaceId: 'ws-1', callerRole: 'owner', operatorId: 1, requestId: 'sonja-turn-3' }
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error_code : null).toBe('UNGROUNDED_BOOKING_TIME')
    expect(mocks.dispatchOperatorReply).not.toHaveBeenCalled()
  })

  it('skips the check (does not block) when no tour-time claim is present at all', async () => {
    fakeBookingTime = '09:00:00'
    const result = await sendReply.execute(
      { conversation_id: 'conv-sonja', body: 'Looking forward to seeing your group!' },
      { workspaceId: 'ws-1', callerRole: 'owner', operatorId: 1, requestId: 'sonja-turn-4' }
    )
    expect(result.ok).toBe(true)
  })

  it('skips the check (does not block) when the booking is ambiguous — more than one booking linked to this conversation', async () => {
    fakeBookingRows = [{ booking_time: '09:00:00' }, { booking_time: '11:00:00' }]
    const result = await sendReply.execute(
      { conversation_id: 'conv-sonja', body: 'Your tour is confirmed for 10:00 a.m.' },
      { workspaceId: 'ws-1', callerRole: 'owner', operatorId: 1, requestId: 'sonja-turn-5' }
    )
    // Deliberately permissive under ambiguity — see fetchAuthoritativeBookingTime's
    // doc comment: a wrong-booking false positive would be worse than skipping.
    expect(result.ok).toBe(true)
  })
})
