import { describe, it, expect, vi } from 'vitest'

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
