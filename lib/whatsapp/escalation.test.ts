import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.resetModules() re-imports the module under test but does NOT clear call
// history on mocks declared in the factories above — so without this, a
// "was not called" assertion sees the previous test's calls.
beforeEach(() => {
  vi.clearAllMocks()
})

vi.mock('server-only', () => ({}))

// recordEscalation pulls in a lot of unrelated machinery (operator brief
// composition, calendar availability, outbound ping queueing). This test
// only cares about one thing — whether holdConversation: false skips the
// unified_conversations.human_agent_enabled update — so everything else is
// stubbed to a fixed, uninteresting value.
vi.mock('@/lib/outreach-autofill', () => ({ clearStaleOutreachAutofill: vi.fn() }))
vi.mock('./triggers', () => ({ enqueueEscalationPings: vi.fn(() => Promise.resolve()) }))
vi.mock('./urgency', () => ({ extractTargetDate: () => null }))
vi.mock('@/lib/calendar-availability', () => ({ getDayAvailability: vi.fn() }))
vi.mock('@/lib/operator-brief', () => ({
  buildOperatorBrief: () => ({ brief: 'brief text', oneLine: 'one line', targetDate: null }),
}))
// Explicitly stubbed even though the cases below pass no body (so extraction
// is skipped anyway): without this, a future test that DOES pass a body would
// make a live Anthropic call from the unit suite.
vi.mock('@/lib/inbound-digest-extract', () => ({
  extractInboundDigest: vi.fn(() => Promise.resolve(null)),
}))
// Only the write is stubbed. The SUBJECT_* constants come from the real
// module, so a test asserting subjectType: 'conversation' is asserting the
// same value escalation.ts and owner-attention-sync.ts actually use — the
// whole point of that constant is that these two producers cannot drift.
vi.mock('@/lib/owner-attention', async () => ({
  ...(await vi.importActual<typeof import('@/lib/owner-attention')>('@/lib/owner-attention')),
  observeAttentionItem: vi.fn(() => Promise.resolve(null)),
}))

interface Row {
  [key: string]: unknown
}

function makeFakeSupabase() {
  const updateCalls: Array<{ table: string; patch: Row }> = []
  const insertCalls: Array<{ table: string; row: Row }> = []

  const client = {
    from(table: string) {
      return {
        select() {
          return this
        },
        eq() {
          return this
        },
        in() {
          return this
        },
        is() {
          return this
        },
        order() {
          return this
        },
        limit() {
          return this
        },
        maybeSingle() {
          // No pre-existing open escalation on the conversation — always
          // take the "create a new row" branch in recordEscalation.
          return Promise.resolve({ data: null, error: null })
        },
        insert(row: Row) {
          insertCalls.push({ table, row })
          return {
            select() {
              return this
            },
            single() {
              return Promise.resolve({ data: { id: 'esc-1' }, error: null })
            },
            then(resolve: (v: { data: null; error: null }) => unknown) {
              return Promise.resolve({ data: null, error: null }).then(resolve)
            },
          }
        },
        update(patch: Row) {
          updateCalls.push({ table, patch })
          return {
            eq() {
              return Promise.resolve({ data: null, error: null })
            },
          }
        },
      }
    },
  }
  return { client, updateCalls, insertCalls }
}

describe('recordEscalation holdConversation', () => {
  it('sets human_agent_enabled by default (holdConversation omitted)', async () => {
    const { client, updateCalls } = makeFakeSupabase()
    vi.doMock('@/lib/supabase-server', () => ({ createServiceClient: () => client }))
    const { recordEscalation } = await import('./escalation')

    await recordEscalation({
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      contactName: 'Robert',
      category: 'policy',
      routeTo: 'owner',
      customerFacingMessage: 'Let me check with the team.',
      internalContext: 'Custom request.',
    })

    const convUpdate = updateCalls.find((c) => c.table === 'unified_conversations')
    expect(convUpdate).toBeDefined()
    expect(convUpdate?.patch.human_agent_enabled).toBe(true)
    vi.resetModules()
  })

  it('skips the human_agent_enabled update when holdConversation is false, but still records + pings', async () => {
    const { client, updateCalls, insertCalls } = makeFakeSupabase()
    vi.doMock('@/lib/supabase-server', () => ({ createServiceClient: () => client }))
    const { recordEscalation } = await import('./escalation')
    const { enqueueEscalationPings } = await import('./triggers')

    const result = await recordEscalation({
      workspaceId: 'ws-1',
      conversationId: 'conv-2',
      contactName: 'Jonathan',
      category: 'knowledge',
      routeTo: 'owner',
      customerFacingMessage: 'For the Full Bimini Experience for two...',
      internalContext: 'Caye self-rated confidence=medium on her reply.',
      holdConversation: false,
    })

    // Not held — the thread stays out of the operator's held queue.
    expect(updateCalls.find((c) => c.table === 'unified_conversations')).toBeUndefined()

    // But the escalation itself, its audit note, and the ping all still
    // fire — "don't hold" only means "don't hold," not "don't tell anyone."
    expect(result.escalationId).toBe('esc-1')
    expect(insertCalls.find((c) => c.table === 'caye_escalations')).toBeDefined()
    expect(insertCalls.find((c) => c.table === 'unified_messages')).toBeDefined()
    expect(enqueueEscalationPings).toHaveBeenCalled()
    vi.resetModules()
  })
})

describe('recordEscalation — digest extraction and attention bookkeeping', () => {
  const base = {
    workspaceId: 'ws-1',
    conversationId: 'conv-3',
    contactName: 'Ruslan Prakapovich',
    category: 'sensitive' as const,
    routeTo: 'owner' as const,
    customerFacingMessage: 'Thanks for reaching out.',
    internalContext: 'B2B partnership enquiry.',
  }

  it('reads a prose inbound structurally instead of quoting its first 400 chars', async () => {
    const { client } = makeFakeSupabase()
    vi.doMock('@/lib/supabase-server', () => ({ createServiceClient: () => client }))
    const { recordEscalation } = await import('./escalation')
    const { extractInboundDigest } = await import('@/lib/inbound-digest-extract')

    await recordEscalation({
      ...base,
      body: 'Dear Karenda, thank you for the thoughtful questions. Could you confirm wheelchair access?',
    })

    expect(extractInboundDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        contactName: 'Ruslan Prakapovich',
        // The reply already sent is passed so commitmentsMade comes from
        // evidence rather than a guess.
        alreadySent: 'Thanks for reaching out.',
      })
    )
    vi.resetModules()
  })

  it('registers the item in the shared attention ledger before the ping goes out', async () => {
    const { client } = makeFakeSupabase()
    vi.doMock('@/lib/supabase-server', () => ({ createServiceClient: () => client }))
    const { recordEscalation } = await import('./escalation')
    const { observeAttentionItem } = await import('@/lib/owner-attention')

    await recordEscalation({ ...base, body: 'Some prose enquiry.' })

    // Keyed by CONVERSATION, not escalation id. owner-attention-sync sees
    // this same thread as a hold and must land on the same ledger row, or one
    // thread becomes two lines in the briefing.
    expect(observeAttentionItem).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        subjectType: 'conversation',
        subjectId: 'conv-3',
        conversationId: 'conv-3',
        // An escalation is by definition something that needs the owner.
        priority: 'decision',
      })
    )
    vi.resetModules()
  })

  it('falls back to the escalation id only when there is no conversation', async () => {
    // A conversation-less escalation has no thread for the sync to find, so
    // it cannot collide — and keying it on the escalation id is the only
    // stable identity available.
    const { client } = makeFakeSupabase()
    vi.doMock('@/lib/supabase-server', () => ({ createServiceClient: () => client }))
    const { recordEscalation } = await import('./escalation')
    const { observeAttentionItem } = await import('@/lib/owner-attention')

    await recordEscalation({ ...base, conversationId: null, body: 'Some prose enquiry.' })

    expect(observeAttentionItem).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: 'escalation', subjectId: 'esc-1' })
    )
    vi.resetModules()
  })

  it('does not spend an LLM call on a message with no body', async () => {
    const { client } = makeFakeSupabase()
    vi.doMock('@/lib/supabase-server', () => ({ createServiceClient: () => client }))
    const { recordEscalation } = await import('./escalation')
    const { extractInboundDigest } = await import('@/lib/inbound-digest-extract')

    await recordEscalation(base)

    expect(extractInboundDigest).not.toHaveBeenCalled()
    vi.resetModules()
  })
})
