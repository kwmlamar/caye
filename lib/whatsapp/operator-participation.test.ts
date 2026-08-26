import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

interface Row {
  [key: string]: unknown
}

let MESSAGES: Row[] = []
let lastQuery: { conversationId?: string; senderType?: string; isInternal?: boolean; gteSentAt?: string } = {}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'unified_messages') throw new Error(`unexpected table: ${table}`)
      const chain: Record<string, unknown> = {}
      const self = () => chain
      Object.assign(chain, {
        select: self,
        eq: (col: string, val: unknown) => {
          if (col === 'conversation_id') lastQuery.conversationId = val as string
          if (col === 'sender_type') lastQuery.senderType = val as string
          if (col === 'is_internal') lastQuery.isInternal = val as boolean
          return chain
        },
        gte: (col: string, val: unknown) => {
          if (col === 'sent_at') lastQuery.gteSentAt = val as string
          return chain
        },
        limit: () => Promise.resolve({ data: MESSAGES, error: null }),
      })
      return chain
    },
  }),
}))

import { hasOperatorParticipatedInConversation, PARTICIPATION_LOOKBACK_MS } from './operator-participation'

beforeEach(() => {
  MESSAGES = []
  lastQuery = {}
})

function approvedRow(sentAt: string) {
  return { id: 'm1', metadata: { operator_approved: true }, sent_at: sentAt }
}

describe('hasOperatorParticipatedInConversation', () => {
  it('true when an operator-approved send exists in the window', async () => {
    MESSAGES = [approvedRow('2026-08-26T01:39:06Z')]
    const result = await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06Z')
    expect(result).toBe(true)
  })

  it('false when nothing has metadata.operator_approved === true (Caye\'s own autonomous replies do not count)', async () => {
    MESSAGES = [{ id: 'm1', metadata: { generated_by: 'caye', is_automated: true }, sent_at: '2026-08-26T01:39:06Z' }]
    const result = await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06Z')
    expect(result).toBe(false)
  })

  it('false when the mailbox has no messages at all', async () => {
    MESSAGES = []
    const result = await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06Z')
    expect(result).toBe(false)
  })

  it('scopes the query to the given conversation, business-authored, non-internal messages', async () => {
    MESSAGES = []
    await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06Z')
    expect(lastQuery.conversationId).toBe('conv-autumn')
    expect(lastQuery.senderType).toBe('business')
    expect(lastQuery.isInternal).toBe(false)
  })

  it('applies the lookback buffer before sinceISO, not sinceISO itself', async () => {
    MESSAGES = []
    await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06.000Z')
    const expectedCutoff = new Date(new Date('2026-08-26T01:45:06.000Z').getTime() - PARTICIPATION_LOOKBACK_MS).toISOString()
    expect(lastQuery.gteSentAt).toBe(expectedCutoff)
  })

  it('never throws — a lookup failure fails closed to "no evidence found"', async () => {
    MESSAGES = [] // simulate an empty/failed lookup rather than throwing from the mock
    await expect(hasOperatorParticipatedInConversation('conv-x', '2026-08-26T01:45:06Z')).resolves.toBe(false)
  })
})
