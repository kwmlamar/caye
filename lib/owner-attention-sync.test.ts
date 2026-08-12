import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

interface Row {
  [key: string]: unknown
}

/** Canonical state the reconciler reads from. Set per test. */
let HELD: Array<Record<string, unknown>> = []
let QUEUE_HOLD_COUNT = 0
let REMINDERS: Row[] = []
let DRAFT_CONVS: Row[] = []
let DRAFT_MSGS: Row[] = []
let OPEN_ESCALATIONS: Row[] = []
let LEDGER_OPEN: Row[] = []

let OBSERVED: Row[] = []
let STATUS_CALLS: Row[] = []

vi.mock('@/lib/hold-kinds', () => ({
  getHeldSummary: () => Promise.resolve({ attention: HELD, queuedCount: QUEUE_HOLD_COUNT }),
}))

vi.mock('@/lib/owner-attention', async () => {
  const actual = await vi.importActual<typeof import('./owner-attention')>('./owner-attention')
  return {
    ...actual,
    observeAttentionItem: vi.fn((args: Row) => {
      OBSERVED.push(args)
      return Promise.resolve(null)
    }),
    setAttentionStatus: vi.fn((args: Row) => {
      STATUS_CALLS.push(args)
      return Promise.resolve()
    }),
  }
})

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const chain: Record<string, unknown> = {}
      const rowsFor = () => {
        if (table === 'caye_outbound_queue') return REMINDERS
        if (table === 'unified_conversations') return DRAFT_CONVS
        if (table === 'unified_messages') return DRAFT_MSGS
        if (table === 'caye_escalations') return OPEN_ESCALATIONS
        if (table === 'caye_owner_attention') return LEDGER_OPEN
        return []
      }
      const settle = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: rowsFor(), error: null }).then(r)
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        order: () => chain,
        limit: () => Promise.resolve({ data: rowsFor(), error: null }),
        then: settle,
      })
      return chain
    },
  }),
}))

import { syncOwnerAttention } from './owner-attention-sync'

beforeEach(() => {
  HELD = []
  QUEUE_HOLD_COUNT = 0
  REMINDERS = []
  DRAFT_CONVS = []
  DRAFT_MSGS = []
  OPEN_ESCALATIONS = []
  LEDGER_OPEN = []
  OBSERVED = []
  STATUS_CALLS = []
  vi.clearAllMocks()
})

function heldConv(over: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    customer_name: 'Ruslan Prakapovich',
    customer_id: null,
    channel_type: 'email',
    human_agent_reason: 'B2B partnership enquiry',
    human_agent_marked_at: '2026-08-12T09:00:00Z',
    last_message_preview: null,
    last_message_at: '2026-08-12T08:55:00Z',
    last_sender_type: 'customer',
    last_business_sender_kind: null,
    target_date: null,
    ...over,
  }
}

const observedFor = (id: string) => OBSERVED.find((o) => o.subjectId === id)

/**
 * The reconciler is what makes `allClear` mean "nothing needs the owner"
 * rather than "no open escalations". These assert it reads every canonical
 * source, and — just as importantly — that it does NOT invent attention for
 * work nobody is waiting on.
 */
describe('syncOwnerAttention — derives the ledger from canonical state', () => {
  it('records a held conversation as an attention item', async () => {
    HELD = [heldConv()]
    await syncOwnerAttention('ws-1')
    const item = observedFor('conv-1')
    expect(item).toBeDefined()
    expect(item!.subjectType).toBe('conversation')
    expect(item!.priority).toBe('decision')
    expect(item!.title).toMatch(/Ruslan Prakapovich/)
  })

  it('marks a held thread whose date has passed as critical', async () => {
    HELD = [heldConv({ target_date: '2020-01-01' })]
    await syncOwnerAttention('ws-1')
    // A date that has gone by with no reply is the one hold state that gets
    // worse purely by sitting there.
    expect(observedFor('conv-1')!.priority).toBe('critical')
  })

  it('says a draft is waiting when one exists', async () => {
    HELD = [heldConv()]
    DRAFT_CONVS = [{ id: 'conv-1', metadata: { proposed_reply: 'Happy to help with that…' } }]
    await syncOwnerAttention('ws-1')
    expect(observedFor('conv-1')!.nextAction).toBe('Draft ready — needs your approval')
  })

  it('finds a draft stored as an internal note, not just on the conversation', async () => {
    HELD = [heldConv()]
    DRAFT_MSGS = [{ conversation_id: 'conv-1', metadata: { proposed_reply: 'Draft body' } }]
    await syncOwnerAttention('ws-1')
    expect(observedFor('conv-1')!.nextAction).toBe('Draft ready — needs your approval')
  })

  it('distinguishes an escalated thread from a plain hold', async () => {
    HELD = [heldConv()]
    OPEN_ESCALATIONS = [{ conversation_id: 'conv-1' }]
    await syncOwnerAttention('ws-1')
    expect(observedFor('conv-1')!.nextAction).toBe('Waiting on your call')
  })

  it('records a scheduled reminder at awareness tier', async () => {
    REMINDERS = [
      {
        id: 'rem-1',
        payload: { original_request: 'call the dive shop about Saturday' },
        scheduled_for: '2026-08-13T13:00:00Z',
      },
    ]
    await syncOwnerAttention('ws-1')
    const item = observedFor('rem-1')
    expect(item!.subjectType).toBe('reminder')
    // A reminder is a nudge, never a judgment call — and awareness items are
    // forbidden from being phrased as a question.
    expect(item!.priority).toBe('awareness')
    expect(item!.title).toMatch(/call the dive shop/)
  })

  it('does NOT create attention for queued outreach nobody is waiting on', async () => {
    // getHeldSummary already excludes queue holds; this asserts the
    // reconciler reads `attention` and not the raw held count. On 2026-08-07
    // one workspace had 19 held threads of which 18 were this kind.
    HELD = []
    QUEUE_HOLD_COUNT = 18
    await syncOwnerAttention('ws-1')
    expect(OBSERVED).toHaveLength(0)
  })

  it('records nothing at all when the business is genuinely quiet', async () => {
    await syncOwnerAttention('ws-1')
    expect(OBSERVED).toHaveLength(0)
    expect(STATUS_CALLS).toHaveLength(0)
  })
})

describe('syncOwnerAttention — resolves what is gone', () => {
  it('resolves a ledger row whose underlying item cleared', async () => {
    HELD = []
    LEDGER_OPEN = [{ subject_type: 'conversation', subject_id: 'conv-stale' }]
    await syncOwnerAttention('ws-1')
    expect(STATUS_CALLS).toEqual([
      expect.objectContaining({ subjectId: 'conv-stale', status: 'resolved' }),
    ])
  })

  it('leaves a row alone while its item is still held', async () => {
    HELD = [heldConv()]
    LEDGER_OPEN = [{ subject_type: 'conversation', subject_id: 'conv-1' }]
    await syncOwnerAttention('ws-1')
    expect(STATUS_CALLS).toHaveLength(0)
  })

  it('never resolves a subject type it does not own', async () => {
    // A producer whose source this function doesn't read must not have its
    // item closed just because it wasn't in the candidate set.
    HELD = []
    LEDGER_OPEN = [{ subject_type: 'escalation', subject_id: 'esc-orphan' }]
    await syncOwnerAttention('ws-1')
    expect(STATUS_CALLS).toHaveLength(0)
  })
})

describe('syncOwnerAttention — one thread, one row', () => {
  it('does not emit a second candidate when a thread is both held and escalated', async () => {
    HELD = [heldConv()]
    OPEN_ESCALATIONS = [{ conversation_id: 'conv-1' }]
    DRAFT_CONVS = [{ id: 'conv-1', metadata: { proposed_reply: 'Draft' } }]
    await syncOwnerAttention('ws-1')
    // Held + escalated + draft-ready is still ONE thing the owner acts on.
    expect(OBSERVED.filter((o) => o.subjectId === 'conv-1')).toHaveLength(1)
  })

  it('keys conversation-backed items on the conversation, matching escalation.ts', async () => {
    HELD = [heldConv()]
    await syncOwnerAttention('ws-1')
    const item = observedFor('conv-1')
    expect(item!.subjectType).toBe('conversation')
    expect(item!.conversationId).toBe('conv-1')
  })
})

describe('syncOwnerAttention — fingerprints track meaning, not the clock', () => {
  it('does not change when only the held-at timestamp moves', async () => {
    HELD = [heldConv()]
    await syncOwnerAttention('ws-1')
    const first = observedFor('conv-1')!.fingerprintParts

    OBSERVED = []
    HELD = [heldConv({ human_agent_marked_at: '2026-08-13T09:00:00Z' })]
    await syncOwnerAttention('ws-1')
    // An item that has merely aged belongs in the unchanged bucket, not
    // re-announced as news every morning.
    expect(observedFor('conv-1')!.fingerprintParts).toEqual(first)
  })

  it('changes when the customer writes again', async () => {
    HELD = [heldConv()]
    await syncOwnerAttention('ws-1')
    const first = observedFor('conv-1')!.fingerprintParts

    OBSERVED = []
    HELD = [heldConv({ last_message_at: '2026-08-13T10:00:00Z' })]
    await syncOwnerAttention('ws-1')
    expect(observedFor('conv-1')!.fingerprintParts).not.toEqual(first)
  })

  it('changes when a draft appears', async () => {
    HELD = [heldConv()]
    await syncOwnerAttention('ws-1')
    const first = observedFor('conv-1')!.fingerprintParts

    OBSERVED = []
    DRAFT_CONVS = [{ id: 'conv-1', metadata: { proposed_reply: 'Draft' } }]
    await syncOwnerAttention('ws-1')
    expect(observedFor('conv-1')!.fingerprintParts).not.toEqual(first)
  })
})
