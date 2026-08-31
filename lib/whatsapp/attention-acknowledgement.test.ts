import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

interface Row {
  [key: string]: unknown
}

let OPEN_ITEMS: Row[] = []
let QUEUE_ROWS: Row[] = []
let STATUS_UPDATES: Array<{ subjectType: string; subjectId: string; status: string }> = []
let AWARENESS_UPDATES: Array<{ subjectType: string; subjectId: string; evidence: string }> = []

function openItem(over: Partial<Row> = {}): Row {
  return {
    subject_type: 'conversation',
    subject_id: 'conv-karin',
    title: 'Karin Roberts — deposit invoice',
    last_notification_queue_id: 'q-karin-1',
    ...over,
  }
}

function passthroughChain(get: () => Row[]) {
  const chain: Record<string, unknown> = {}
  const self = () => chain
  Object.assign(chain, {
    select: self,
    eq: self,
    in: self,
    order: self,
    limit: () => Promise.resolve({ data: get(), error: null }),
    maybeSingle: () => Promise.resolve({ data: get()[0] ?? null, error: null }),
    // The real query for open items is awaited directly after .eq()/.in()
    // with no terminal .maybeSingle()/.limit() call — make the chain itself
    // thenable so `await ...eq(...).in(...)` resolves to {data, error}.
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
      Promise.resolve({ data: get(), error: null }).then(resolve),
  })
  return chain
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'caye_owner_attention') return passthroughChain(() => OPEN_ITEMS)
      if (table === 'caye_outbound_queue') return passthroughChain(() => QUEUE_ROWS)
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

vi.mock('@/lib/owner-attention', () => ({
  recordOperatorAwareness: vi.fn((args: { subjectType: string; subjectId: string; evidence: string }) => {
    AWARENESS_UPDATES.push(args)
    return Promise.resolve()
  }),
  setAttentionStatus: vi.fn((args: { subjectType: string; subjectId: string; status: string }) => {
    STATUS_UPDATES.push(args)
    return Promise.resolve()
  }),
}))

import { resolveAcknowledgedAttentionItems, acknowledgeAttentionItems } from './attention-acknowledgement'

beforeEach(() => {
  OPEN_ITEMS = []
  QUEUE_ROWS = []
  STATUS_UPDATES = []
  AWARENESS_UPDATES = []
})

describe('scoped acknowledgement — the Mrs. Max scenario from the brief', () => {
  it('a generic, unrelated reply does NOT acknowledge an open Karin reminder', async () => {
    OPEN_ITEMS = [openItem()]
    const matched = await resolveAcknowledgedAttentionItems({
      workspaceId: 'ws',
      bodyText: 'What bookings do we have Saturday?',
    })
    expect(matched).toHaveLength(0)
  })

  it('a bare "ok"/"thanks" resolves to nothing — ambiguous replies never acknowledge', async () => {
    OPEN_ITEMS = [openItem()]
    for (const text of ['ok', 'thanks', 'yes', 'got it']) {
      const matched = await resolveAcknowledgedAttentionItems({ workspaceId: 'ws', bodyText: text })
      expect(matched, text).toHaveLength(0)
    }
  })

  it('a reply naming the specific person acknowledges only that item', async () => {
    OPEN_ITEMS = [
      openItem(),
      openItem({ subject_id: 'conv-christina', title: 'Christina Masters — booking confirmed' }),
    ]
    const matched = await resolveAcknowledgedAttentionItems({
      workspaceId: 'ws',
      bodyText: "I'll send Karin her invoice this afternoon",
    })
    expect(matched).toEqual([{ subjectType: 'conversation', subjectId: 'conv-karin' }])
  })

  it('WhatsApp reply-to a specific ping is unambiguous even with generic text', async () => {
    OPEN_ITEMS = [openItem()]
    QUEUE_ROWS = [{ id: 'q-karin-1' }]
    const matched = await resolveAcknowledgedAttentionItems({
      workspaceId: 'ws',
      replyToMessageId: 'wamid.karin-ping',
      bodyText: 'got it, on it',
    })
    expect(matched).toEqual([{ subjectType: 'conversation', subjectId: 'conv-karin' }])
  })

  it('a reply-to that does not resolve to a tracked notification falls back to the text signal, not a guess', async () => {
    OPEN_ITEMS = [openItem()]
    QUEUE_ROWS = [] // reply-to id doesn't match any known outbound row
    const matched = await resolveAcknowledgedAttentionItems({
      workspaceId: 'ws',
      replyToMessageId: 'wamid.unknown',
      bodyText: 'what bookings do we have Saturday?',
    })
    expect(matched).toHaveLength(0)
  })

  it('a name appearing in two open items at once is ambiguous and resolves nothing', async () => {
    OPEN_ITEMS = [
      openItem({ subject_id: 'a', title: 'Karin — deposit invoice' }),
      openItem({ subject_id: 'b', title: 'Karin — separate follow-up' }),
    ]
    const matched = await resolveAcknowledgedAttentionItems({
      workspaceId: 'ws',
      bodyText: 'Karin is all set now',
    })
    expect(matched).toHaveLength(0)
  })

  it('acknowledgeAttentionItems records current-state awareness before marking the scoped item acknowledged', async () => {
    await acknowledgeAttentionItems('ws', [{ subjectType: 'conversation', subjectId: 'conv-karin' }])
    expect(AWARENESS_UPDATES).toEqual([
      {
        workspaceId: 'ws',
        subjectType: 'conversation',
        subjectId: 'conv-karin',
        evidence: 'operator directly acknowledged this attention item',
      },
    ])
    expect(STATUS_UPDATES).toEqual([
      { workspaceId: 'ws', subjectType: 'conversation', subjectId: 'conv-karin', status: 'acknowledged' },
    ])
  })

  it('no open items means nothing to acknowledge, regardless of message content', async () => {
    OPEN_ITEMS = []
    const matched = await resolveAcknowledgedAttentionItems({
      workspaceId: 'ws',
      bodyText: 'Karin is all set now',
    })
    expect(matched).toHaveLength(0)
  })
})
