import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../types'

vi.mock('server-only', () => ({}))

vi.mock('../write-low/_guards', () => ({
  assertConversationOwnedByWorkspace: vi.fn(async () => ({ ok: true })),
}))

const unsupportedLogisticsTimeClaimsMock = vi.fn((_body: string, _corpus: string) => [] as string[])
vi.mock('../../logistics-grounding', () => ({
  unsupportedLogisticsTimeClaims: (body: string, corpus: string) => unsupportedLogisticsTimeClaimsMock(body, corpus),
}))

const businessFactsMock = vi.fn(async (_workspaceId: string) => [] as Array<{ id: string; category: string; fact: string }>)
vi.mock('@/lib/business-facts', () => ({
  fetchBusinessFacts: (workspaceId: string) => businessFactsMock(workspaceId),
}))

const dispatchOperatorReplyMock = vi.fn(async (_conversationId: string, _text: string, _sender: string) => ({
  success: true as const,
  channelType: 'whatsapp',
  messageId: 'm1',
}))
vi.mock('@/lib/whatsapp/channel-dispatch', () => ({
  dispatchOperatorReply: (conversationId: string, text: string, sender: string) =>
    dispatchOperatorReplyMock(conversationId, text, sender),
}))

// Channel-context behavior is covered by frontdesk-context-guard.test.ts;
// this boundary suite isolates evidence and dispatch behavior.
vi.mock('../../frontdesk-context-guard', () => ({
  validateFrontDeskContext: vi.fn(async () => null),
}))

const conversationUpdateCalls: unknown[] = []
let threadRowsMock: Array<{ content: string; sender_type?: string }> = []
// Sonja-style booking time on the fake conversation-linked booking, so the
// new UNGROUNDED_BOOKING_TIME check (validateAuthoritativeBookingTimeClaims)
// has something to check the front-desk draft against.
let fakeBookingTimeMock: string | null = null
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'bookings') {
        const query = {
          eq: () => query,
          neq: () => query,
          then: (resolve: (v: { data: Array<{ status: string; booking_time: string | null }> }) => void) =>
            resolve({ data: fakeBookingTimeMock === null ? [] : [{ status: 'confirmed', booking_time: fakeBookingTimeMock }] }),
        }
        return { select: () => query }
      }
      if (table === 'unified_messages') {
        return {
          select: () => {
            // Chainable .eq() any number of times (the plain thread fetch
            // uses two — conversation_id, is_internal — the business-only
            // fetch adds a third — sender_type), terminated by .order().
            // Faithfully filters by sender_type when that column is
            // matched, so a test can verify a customer's own words don't
            // leak into the business-only grounding fetch.
            const filters: Array<(r: { content: string; sender_type?: string }) => boolean> = []
            const builder = {
              eq: (col: string, val: unknown) => {
                if (col === 'sender_type') filters.push((r) => r.sender_type === val)
                return builder
              },
              order: () => ({
                limit: () =>
                  Promise.resolve({
                    data: threadRowsMock.filter((r) => filters.every((f) => f(r))),
                    error: null,
                  }),
              }),
            }
            return builder
          },
        }
      }
      if (table === 'unified_conversations') {
        return {
          update: (patch: unknown) => ({
            eq: (col: string, val: unknown) => {
              conversationUpdateCalls.push({ patch, col, val })
              return Promise.resolve({ error: null })
            },
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { sendCustomerReply } from './send-customer-reply'

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: 'ws1',
    callerRole: 'owner',
    requestId: 'req1',
    evidenceCollected: [],
    ...overrides,
  }
}

describe('sendCustomerReply', () => {
  beforeEach(() => {
    dispatchOperatorReplyMock.mockClear()
    unsupportedLogisticsTimeClaimsMock.mockReset().mockReturnValue([])
    businessFactsMock.mockReset().mockResolvedValue([])
    conversationUpdateCalls.length = 0
    threadRowsMock = []
    fakeBookingTimeMock = null
  })

  it('sends autonomously (no send-blocking claim) when the draft makes no price/availability claim', async () => {
    const result = await sendCustomerReply.execute(
      { conversation_id: 'c1', body: 'Thanks for reaching out — happy to help with anything else.' },
      ctx()
    )
    expect(result.ok).toBe(true)
    expect(dispatchOperatorReplyMock).toHaveBeenCalledWith('c1', expect.any(String), 'caye-frontdesk-agent')
  })

  it('holds a price claim with no price_from_database evidence — nothing sent', async () => {
    const result = await sendCustomerReply.execute(
      { conversation_id: 'c1', body: 'That will be $450 total for 2 guests.' },
      ctx({ evidenceCollected: [] })
    )
    expect(result.ok).toBe(false)
    expect(result.status).toBe('NEEDS_HUMAN')
    expect(result.error_code).toBe('INSUFFICIENT_EVIDENCE')
    expect(dispatchOperatorReplyMock).not.toHaveBeenCalled()
  })

  it('sends a price claim once service_identified + price_from_database evidence exists', async () => {
    const result = await sendCustomerReply.execute(
      { conversation_id: 'c1', body: 'That will be $450 total for 2 guests.' },
      ctx({ evidenceCollected: ['service_identified', 'price_from_database'] })
    )
    expect(result.ok).toBe(true)
    expect(dispatchOperatorReplyMock).toHaveBeenCalled()
  })

  it('holds an availability claim with no availability_verified evidence', async () => {
    const result = await sendCustomerReply.execute(
      { conversation_id: 'c1', body: 'That date is available for you.' },
      ctx({ evidenceCollected: [] })
    )
    expect(result.ok).toBe(false)
    expect(result.status).toBe('NEEDS_HUMAN')
    expect(dispatchOperatorReplyMock).not.toHaveBeenCalled()
  })

  it('blocks on an ungrounded logistics-time claim regardless of evidence', async () => {
    unsupportedLogisticsTimeClaimsMock.mockReturnValue(['ferry arrival time not supported by thread'])
    const result = await sendCustomerReply.execute(
      { conversation_id: 'c1', body: 'The ferry arrives at 11am.' },
      ctx({ evidenceCollected: ['service_identified', 'price_from_database'] })
    )
    expect(result.ok).toBe(false)
    expect(result.error_code).toBe('UNGROUNDED_LOGISTICS_TIME')
    expect(dispatchOperatorReplyMock).not.toHaveBeenCalled()
  })

  it('blocks a reply that signs off as Caye or discloses AI nature (identity-leak guard)', async () => {
    const result = await sendCustomerReply.execute(
      { conversation_id: 'c1', body: "Happy to help! Best, Caye" },
      ctx()
    )
    expect(result.ok).toBe(false)
    expect(result.error_code).toBe('IDENTITY_LEAK')
    expect(dispatchOperatorReplyMock).not.toHaveBeenCalled()
  })

  it('blocks an unverified payment-figure claim even with sufficient booking evidence (payment-figure guard)', async () => {
    const result = await sendCustomerReply.execute(
      { conversation_id: 'c1', body: 'A 25% deposit ($99.50) is required to hold the date.' },
      ctx({ evidenceCollected: ['service_identified', 'price_from_database'] })
    )
    expect(result.ok).toBe(false)
    expect(result.error_code).toBe('UNVERIFIED_PAYMENT_FIGURE')
    expect(dispatchOperatorReplyMock).not.toHaveBeenCalled()
  })

  it('allows a payment-figure claim once the business facts actually attest it (and evidence covers the $ amount)', async () => {
    businessFactsMock.mockResolvedValue([{ id: 'f1', category: 'policy', fact: 'A 25% deposit is required at booking.' }])
    const result = await sendCustomerReply.execute(
      { conversation_id: 'c1', body: 'A 25% deposit ($99.50) is required to hold the date.' },
      ctx({ evidenceCollected: ['service_identified', 'price_from_database'] })
    )
    expect(result.ok).toBe(true)
  })

  it('blocks an unverified payment-method claim (real Bimini cash-acceptance incident)', async () => {
    const result = await sendCustomerReply.execute(
      { conversation_id: 'c1', body: 'Unfortunately, cash is not accepted for this tour.' },
      ctx()
    )
    expect(result.ok).toBe(false)
    expect(result.error_code).toBe('UNVERIFIED_PAYMENT_METHOD')
    expect(dispatchOperatorReplyMock).not.toHaveBeenCalled()
  })

  it('blocks the EXACT text a real live model produced for an ungrounded Venmo question (global-cutover acceptance run, 2026-08-16)', async () => {
    // This is not a hand-written adversarial string — it is the verbatim
    // reply a real claude-sonnet-4-6 call produced during behavioral
    // acceptance testing for "do you accept Venmo?" with zero business
    // facts loaded. wrapToolsForDryRun (used for the live acceptance
    // script) replaces execute() entirely and never exercises this guard
    // — this test closes that gap by running the REAL execute() against
    // the REAL text the model actually wrote, proving the guard would
    // have blocked it in production, not just in a synthetic example.
    const result = await sendCustomerReply.execute(
      {
        conversation_id: 'c1',
        body: "We accept card payments only — all payments are processed through an invoice we send directly to you. Unfortunately we don't accept Venmo, cash, or Zelle. Let me know if you have any other questions!",
      },
      ctx()
    )
    expect(result.ok).toBe(false)
    expect(result.error_code).toBe('UNVERIFIED_PAYMENT_METHOD')
    expect(dispatchOperatorReplyMock).not.toHaveBeenCalled()
  })

  it('allows a payment-method claim once the business facts actually document it', async () => {
    businessFactsMock.mockResolvedValue([{ id: 'f1', category: 'policy', fact: 'We accept cash or card on the day of the tour.' }])
    const result = await sendCustomerReply.execute(
      { conversation_id: 'c1', body: 'Cash is accepted on the day of your tour.' },
      ctx()
    )
    expect(result.ok).toBe(true)
  })

  it('Juli-class fix: grounds a payment-method claim in an operator correction the business already sent THIS customer, not just business_facts', async () => {
    // No business_facts row documents this — the ONLY source of truth is
    // Mrs. Max's own earlier correction, sent as a real message in this
    // customer's thread. This is exactly the shape the global-cutover
    // acceptance run surfaced: Caye's own good-faith recovery reply
    // ("cash on the day is totally fine") would otherwise be blocked by
    // the guard it needs to pass, undoing the correct reasoning.
    threadRowsMock = [
      { content: 'Hi, quick question, can we pay in cash on the day?', sender_type: 'customer' },
      { content: 'Unfortunately cash is not accepted, card only.', sender_type: 'business' },
      { content: 'Hi again, small correction, you can absolutely pay Max in cash the day of the tour, no problem at all!', sender_type: 'business' },
    ]
    const result = await sendCustomerReply.execute(
      { conversation_id: 'c1', body: 'Just to clarify, cash on the day is totally fine after all.' },
      ctx()
    )
    expect(result.ok).toBe(true)
  })

  it('a customer merely ASSERTING a payment method does not itself ground the claim (only business-sent thread content does)', async () => {
    threadRowsMock = [
      { content: 'You guys told me on the phone that Venmo is fine, right?', sender_type: 'customer' },
    ]
    const result = await sendCustomerReply.execute(
      { conversation_id: 'c1', body: 'Yes, Venmo is accepted for this tour.' },
      ctx()
    )
    expect(result.ok).toBe(false)
    expect(result.error_code).toBe('UNVERIFIED_PAYMENT_METHOD')
  })

  it('rejects an empty body without touching any dependency', async () => {
    const result = await sendCustomerReply.execute({ conversation_id: 'c1', body: '   ' }, ctx())
    expect(result.ok).toBe(false)
    expect(dispatchOperatorReplyMock).not.toHaveBeenCalled()
  })

  it('is tagged high-risk and front-desk only', () => {
    expect(sendCustomerReply.risk).toBe('high')
    expect(sendCustomerReply.modes).toEqual(['front-desk'])
  })

  describe('2026-08-26 Sonja Pettus incident — concurrent-autonomous-send protection', () => {
    it('blocks the autonomous front-desk from asserting a tour time that does not match the authoritative booking record', async () => {
      // The scenario this guards: an operator's reschedule_booking call
      // has already moved the authoritative record to 10:00 while an
      // autonomous front-desk turn — working from a stale read, or simply
      // composing the wrong thing — tries to tell the customer 9:00.
      fakeBookingTimeMock = '10:00:00'
      const result = await sendCustomerReply.execute(
        { conversation_id: 'c1', body: 'Just confirming — your tour is at 9:00 a.m. tomorrow, see you then!' },
        ctx()
      )
      expect(result.ok).toBe(false)
      expect(result.error_code).toBe('UNGROUNDED_BOOKING_TIME')
      expect(dispatchOperatorReplyMock).not.toHaveBeenCalled()
    })

    it('allows the autonomous front-desk to state a tour time that matches the authoritative booking record', async () => {
      fakeBookingTimeMock = '10:00:00'
      const result = await sendCustomerReply.execute(
        { conversation_id: 'c1', body: 'Just confirming — your tour is at 10:00 a.m. tomorrow, see you then!' },
        ctx()
      )
      expect(result.ok).toBe(true)
      expect(dispatchOperatorReplyMock).toHaveBeenCalled()
    })
  })
})
