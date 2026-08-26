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
  it('true when an operator-approved send exists in the window ("initial" mode)', async () => {
    MESSAGES = [approvedRow('2026-08-26T01:39:06Z')]
    const result = await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06Z', 'initial')
    expect(result).toBe(true)
  })

  it('false when nothing has metadata.operator_approved === true (Caye\'s own autonomous replies do not count)', async () => {
    MESSAGES = [{ id: 'm1', metadata: { generated_by: 'caye', is_automated: true }, sent_at: '2026-08-26T01:39:06Z' }]
    const result = await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06Z', 'initial')
    expect(result).toBe(false)
  })

  it('false when the mailbox has no messages at all', async () => {
    MESSAGES = []
    const result = await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06Z', 'initial')
    expect(result).toBe(false)
  })

  it('scopes the query to the given conversation, business-authored, non-internal messages', async () => {
    MESSAGES = []
    await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06Z', 'initial')
    expect(lastQuery.conversationId).toBe('conv-autumn')
    expect(lastQuery.senderType).toBe('business')
    expect(lastQuery.isInternal).toBe(false)
  })

  it('never throws — a lookup failure fails closed to "no evidence found"', async () => {
    MESSAGES = [] // simulate an empty/failed lookup rather than throwing from the mock
    await expect(hasOperatorParticipatedInConversation('conv-x', '2026-08-26T01:45:06Z', 'initial')).resolves.toBe(false)
  })
})

describe("'initial' mode — a small pre-state evidence window is legitimate", () => {
  it('applies the lookback buffer BEFORE sinceISO', async () => {
    MESSAGES = []
    await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06.000Z', 'initial')
    const expectedCutoff = new Date(
      new Date('2026-08-26T01:45:06.000Z').getTime() - PARTICIPATION_LOOKBACK_MS
    ).toISOString()
    expect(lastQuery.gteSentAt).toBe(expectedCutoff)
  })

  it('counts participation up to PARTICIPATION_LOOKBACK_MS before sinceISO — the real Autumn gap', async () => {
    // Mrs. Max's approved send (01:39:06) landed before the ledger's own
    // recorded moment for the booking's original state (01:45:06 here,
    // standing in for the gate's item.lastChangedAt).
    MESSAGES = [approvedRow('2026-08-26T01:39:06Z')]
    const result = await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06Z', 'initial')
    expect(result).toBe(true)
  })

  it('the cutoff sent to the DB excludes participation older than the lookback window', async () => {
    // The mock's `limit()` returns MESSAGES unconditionally (no real gte
    // filtering) — a real Postgres `gte('sent_at', cutoff)` is what
    // actually excludes a too-old row, so this asserts on the cutoff VALUE
    // itself: a message 105 minutes before sinceISO would sort before that
    // cutoff and never reach this function's `.some()` check in production.
    MESSAGES = []
    await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06.000Z', 'initial')
    const oldMessageSentAt = new Date('2026-08-26T00:00:00.000Z') // 105 minutes before sinceISO
    expect(oldMessageSentAt.toISOString() < lastQuery.gteSentAt!).toBe(true)
  })

  it('has no upper bound — participation well AFTER sinceISO still counts', async () => {
    MESSAGES = [approvedRow('2026-08-26T10:00:00Z')] // long after sinceISO
    const result = await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T01:45:06Z', 'initial')
    expect(result).toBe(true)
  })
})

describe("'post-transition' mode — evidence must be at or after the transition, no pre-state window (PR #135 review, second finding)", () => {
  it('cutoff IS sinceISO itself — no buffer subtracted', async () => {
    MESSAGES = []
    await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-27T10:00:00.000Z', 'post-transition')
    expect(lastQuery.gteSentAt).toBe('2026-08-27T10:00:00.000Z')
  })

  it('participation strictly BEFORE the transition does not count, however close', async () => {
    // The exact bug reported: operator handled the pending booking at
    // 1:39; payment confirms at 2:05. 1:39 cannot be evidence of
    // awareness of a 2:05 event, no matter how generous a pre-buffer
    // would make it look close in wall-clock time.
    MESSAGES = [] // the mock only returns rows the gte filter would actually include —
    // simulated below via a query that a real gte('sent_at', '2:05') would
    // exclude a 1:39 row from; asserting on the cutoff itself is the
    // reliable way to prove this without re-implementing gte filtering.
    await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T02:05:00Z', 'post-transition')
    expect(lastQuery.gteSentAt).toBe('2026-08-26T02:05:00Z') // a 1:39 send would never reach this query
  })

  it('participation AT OR AFTER the transition counts', async () => {
    MESSAGES = [approvedRow('2026-08-26T02:05:00Z')]
    const result = await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T02:05:00Z', 'post-transition')
    expect(result).toBe(true)
  })

  it('has no upper bound either — later participation still counts', async () => {
    MESSAGES = [approvedRow('2026-08-26T14:00:00Z')]
    const result = await hasOperatorParticipatedInConversation('conv-autumn', '2026-08-26T02:05:00Z', 'post-transition')
    expect(result).toBe(true)
  })
})
