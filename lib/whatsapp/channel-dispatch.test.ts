import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const sendWhatsAppMessageMock = vi.fn(
  async (_to: string, _body: string, _phoneNumberId: string, _accessToken: string) => undefined
)
vi.mock('@/lib/whatsapp', () => ({
  sendWhatsAppMessage: (to: string, body: string, phoneNumberId: string, accessToken: string) =>
    sendWhatsAppMessageMock(to, body, phoneNumberId, accessToken),
}))
vi.mock('@/lib/meta-reply', () => ({ sendMetaMessage: vi.fn() }))
vi.mock('@/lib/email-ai', () => ({ sendZohoReply: vi.fn(), sendZohoEmail: vi.fn() }))
vi.mock('@/lib/voice-profile', () => ({ ensureTagline: (text: string) => text }))
const resolveOpenEscalationsMock = vi.fn(async (_supabase: unknown, _conversationId: string) => undefined)
vi.mock('@/lib/caye-agent/tools/write-low/resolve-open-escalations', () => ({
  resolveOpenEscalations: (supabase: unknown, conversationId: string) =>
    resolveOpenEscalationsMock(supabase, conversationId),
}))
const recordSalesLifecycleEventMock = vi.fn(async (_input: Record<string, unknown>) => undefined)
vi.mock('@/lib/sales/lifecycle', () => ({
  recordSalesLifecycleEvent: (input: Record<string, unknown>) => recordSalesLifecycleEventMock(input),
}))

type Row = Record<string, unknown>
const insertedMessages: Row[] = []
const existingByKey = new Map<string, Row>()
let conversationMetadata: Record<string, unknown> = {}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'unified_messages') {
        return {
          select: () => {
            const filters: Array<(r: Row) => boolean> = []
            const builder = {
              eq: (col: string, val: unknown) => {
                filters.push((r) => r[col] === val)
                return builder
              },
              contains: (col: string, val: Record<string, unknown>) => {
                filters.push((r) => {
                  const meta = (r[col] ?? {}) as Record<string, unknown>
                  return Object.entries(val).every(([k, v]) => meta[k] === v)
                })
                return builder
              },
              maybeSingle: async () => {
                const rows = insertedMessages.filter((r) => filters.every((f) => f(r)))
                return { data: rows[rows.length - 1] ?? null, error: null }
              },
            }
            return builder
          },
          insert: (row: Row) => {
            insertedMessages.push(row)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'unified_conversations') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'conv1',
                  channel_type: 'whatsapp',
                  customer_id: '15551234567',
                  channel_conversation_id: null,
                  metadata: conversationMetadata,
                  connected_account: {
                    id: 'acct1',
                    user_id: 'ws1',
                    channel_type: 'whatsapp',
                    channel_account_id: 'phone_num_id',
                    access_token: 'tok',
                    metadata: {},
                  },
                },
                error: null,
              }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { dispatchOperatorReply } from './channel-dispatch'

describe('dispatchOperatorReply idempotency (2026-08-16, final pre-canary closure)', () => {
  beforeEach(() => {
    sendWhatsAppMessageMock.mockClear()
    insertedMessages.length = 0
    existingByKey.clear()
    resolveOpenEscalationsMock.mockReset().mockResolvedValue(undefined)
    recordSalesLifecycleEventMock.mockReset().mockResolvedValue(undefined)
    conversationMetadata = {}
  })

  it('sends for real on the first call with an idempotencyKey, and stores it', async () => {
    const result = await dispatchOperatorReply('conv1', 'Hello!', 'caye-frontdesk-agent', 'inbound-msg-1')
    expect(sendWhatsAppMessageMock).toHaveBeenCalledTimes(1)
    expect(result.deduped).toBe(false)
    expect(insertedMessages).toHaveLength(1)
    expect((insertedMessages[0].metadata as Record<string, unknown>).idempotency_key).toBe('inbound-msg-1')
  })

  it('does NOT send again on a retry with the SAME idempotencyKey — returns the existing result instead', async () => {
    const first = await dispatchOperatorReply('conv1', 'Hello!', 'caye-frontdesk-agent', 'inbound-msg-1')
    sendWhatsAppMessageMock.mockClear()

    const second = await dispatchOperatorReply('conv1', 'Hello!', 'caye-frontdesk-agent', 'inbound-msg-1')

    expect(sendWhatsAppMessageMock).not.toHaveBeenCalled()
    expect(second.deduped).toBe(true)
    expect(second.messageId).toBe(first.messageId)
    expect(insertedMessages).toHaveLength(1)
  })

  it('sends independently for a DIFFERENT idempotencyKey on the same conversation', async () => {
    await dispatchOperatorReply('conv1', 'First reply', 'caye-frontdesk-agent', 'inbound-msg-1')
    sendWhatsAppMessageMock.mockClear()

    const second = await dispatchOperatorReply('conv1', 'Second reply', 'caye-frontdesk-agent', 'inbound-msg-2')

    expect(sendWhatsAppMessageMock).toHaveBeenCalledTimes(1)
    expect(second.deduped).toBe(false)
    expect(insertedMessages).toHaveLength(2)
  })

  it('always sends when no idempotencyKey is provided — unchanged behavior for existing callers (back-office send_reply)', async () => {
    await dispatchOperatorReply('conv1', 'Hello!', 'caye-operator-wa')
    await dispatchOperatorReply('conv1', 'Hello!', 'caye-operator-wa')

    expect(sendWhatsAppMessageMock).toHaveBeenCalledTimes(2)
    expect(insertedMessages).toHaveLength(2)
    expect((insertedMessages[0].metadata as Record<string, unknown>).idempotency_key).toBeUndefined()
  })

  describe('post-send bookkeeping failures never look like a dispatch failure', () => {
    it('resolves successfully even when resolveOpenEscalations throws AFTER the send already persisted', async () => {
      resolveOpenEscalationsMock.mockRejectedValue(new Error('caye_escalations update timed out'))

      const result = await dispatchOperatorReply('conv1', 'Hello!', 'caye-operator-wa')

      // The provider call and the core receipt already succeeded — a
      // best-effort follow-up failing must never surface as
      // dispatchOperatorReply throwing (every caller treats a thrown,
      // unclassified Error here as "definitely did not send" and would
      // incorrectly free the claim/reservation for a retry).
      expect(result.success).toBe(true)
      expect(sendWhatsAppMessageMock).toHaveBeenCalledTimes(1)
      expect(insertedMessages).toHaveLength(1)
    })

    it('resolves successfully even when recordSalesLifecycleEvent throws on an outreach send AFTER the email already sent', async () => {
      conversationMetadata = { source: 'outreach_leads', lead_id: 'lead-1', hold_kind: 'outreach_first_touch' }
      recordSalesLifecycleEventMock.mockRejectedValue(new Error('sales lifecycle first_touch_sent was not recorded: conflict'))

      const result = await dispatchOperatorReply(
        'conv1',
        'Hello!',
        'caye-outreach-autonomous'
      )

      expect(result.success).toBe(true)
      expect(sendWhatsAppMessageMock).toHaveBeenCalledTimes(1)
      expect(recordSalesLifecycleEventMock).toHaveBeenCalledTimes(1)
    })
  })
})
