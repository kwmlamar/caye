import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

vi.mock('server-only', () => ({}))

const insertedRow = { id: 'inbound-row-1' }
// Rows summarizeInvestigation() (the REAL implementation — see the
// './investigation' mock below, which no longer overrides it) reads back
// from 'caye_tool_calls' when a test needs runInvestigation's exhaustion
// path to produce a real, non-empty digest. Reset per-test.
let toolCallRows: Array<Record<string, unknown>> = []
const supabaseStub = {
  from: vi.fn((table: string) => {
    if (table === 'caye_tool_calls') {
      const builder = {
        eq: vi.fn(() => builder),
        order: vi.fn(() => Promise.resolve({ data: toolCallRows, error: null })),
      }
      return { select: vi.fn(() => builder) }
    }
    return {
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({ data: insertedRow })),
        })),
      })),
    }
  }),
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => supabaseStub,
}))

const getThreadMock = vi.fn()
const setThreadStatusMock = vi.fn()
const touchThreadMock = vi.fn()
const linkMessageToThreadMock = vi.fn()
const linkInsertedMessagesToThreadsMock = vi.fn()
vi.mock('@/lib/caye-direct-threads', () => ({
  getThread: (...args: unknown[]) => getThreadMock(...args),
  setThreadStatus: (...args: unknown[]) => setThreadStatusMock(...args),
  touchThread: (...args: unknown[]) => touchThreadMock(...args),
  linkMessageToThread: (...args: unknown[]) => linkMessageToThreadMock(...args),
  linkInsertedMessagesToThreads: (...args: unknown[]) => linkInsertedMessagesToThreadsMock(...args),
}))

const resolveFounderOperatorMock = vi.fn((..._args: unknown[]) => Promise.resolve({ id: 7, name: 'Lamar', role: 'founder' }))
vi.mock('@/lib/operator-identity', () => ({
  resolveFounderOperator: (...args: unknown[]) => resolveFounderOperatorMock(...args),
}))

const persistAgentTurnsMock = vi.fn((..._args: unknown[]) => Promise.resolve([{ id: 'turn-1' }, { id: 'turn-2' }]))
vi.mock('@/lib/caye-operator-messages', () => ({
  persistAgentTurns: (...args: unknown[]) => persistAgentTurnsMock(...args),
}))

const maybeGenerateThreadTitleMock = vi.fn((..._args: unknown[]) => Promise.resolve())
const maybeRefreshThreadSummaryMock = vi.fn((..._args: unknown[]) => Promise.resolve())
vi.mock('@/lib/caye-direct-threads-summarize', () => ({
  maybeGenerateThreadTitle: (...args: unknown[]) => maybeGenerateThreadTitleMock(...args),
  maybeRefreshThreadSummary: (...args: unknown[]) => maybeRefreshThreadSummaryMock(...args),
}))

interface MockCayeAgentResult {
  replyText: string
  newTurns: Anthropic.MessageParam[]
  linkedThreadIds: string[]
  ranOutOfIterations?: boolean
}
const cayeAgentMock = vi.fn(
  (..._args: unknown[]): Promise<MockCayeAgentResult> =>
    Promise.resolve({ replyText: 'Here you go.', newTurns: [], linkedThreadIds: [] })
)
vi.mock('./index', () => ({
  cayeAgent: (...args: unknown[]) => cayeAgentMock(...args),
}))

const runCayeDirectRouterTurnMock = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ replyText: 'Router says hi.', newTurns: [], linkedThreadIds: [], backend: 'claude_subscription' })
)
vi.mock('@/lib/model-router/caye-direct-bridge', () => ({
  runCayeDirectRouterTurn: (...args: unknown[]) => runCayeDirectRouterTurnMock(...args),
}))

// './investigation' is NOT mocked: runInvestigation lives there and calls
// its own sibling summarizeInvestigation directly (an intra-module call,
// invisible to a partial vi.mock override from this file's perspective) —
// so the real chain runs against supabaseStub's 'caye_tool_calls' rows above.

import { runFounderThreadTurn } from './founder-thread-turn'
import { MAX_INVESTIGATION_CONTINUATIONS } from './investigation'

describe('runFounderThreadTurn — the single path both typed and voice turns share', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveFounderOperatorMock.mockResolvedValue({ id: 7, name: 'Lamar', role: 'founder' })
    persistAgentTurnsMock.mockResolvedValue([{ id: 'turn-1' }, { id: 'turn-2' }])
    cayeAgentMock.mockResolvedValue({ replyText: 'Here you go.', newTurns: [], linkedThreadIds: [] })
    toolCallRows = []
  })

  it('throws "Thread not found" when the thread does not exist for this workspace', async () => {
    getThreadMock.mockResolvedValue(null)
    await expect(runFounderThreadTurn('ws-1', 'thread-1', 'hello')).rejects.toThrow('Thread not found')
    expect(cayeAgentMock).not.toHaveBeenCalled()
  })

  it('resumes an archived thread before running the turn', async () => {
    getThreadMock.mockResolvedValue({ id: 'thread-1', status: 'archived' })
    await runFounderThreadTurn('ws-1', 'thread-1', 'hello')
    expect(setThreadStatusMock).toHaveBeenCalledWith(supabaseStub, 'ws-1', 'thread-1', 'active')
  })

  it('does not touch thread status when already active', async () => {
    getThreadMock.mockResolvedValue({ id: 'thread-1', status: 'active' })
    await runFounderThreadTurn('ws-1', 'thread-1', 'hello')
    expect(setThreadStatusMock).not.toHaveBeenCalled()
  })

  it('calls cayeAgent in back-office mode, scoped to this thread, as founder', async () => {
    getThreadMock.mockResolvedValue({ id: 'thread-1', status: 'active' })
    await runFounderThreadTurn('ws-1', 'thread-1', 'What is going on with Kenneth?')
    expect(cayeAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'back-office',
        workspaceId: 'ws-1',
        userMessage: 'What is going on with Kenneth?',
        callerRole: 'founder',
        threadId: 'thread-1',
        operatorId: 7,
      })
    )
  })

  it('persists the agent turns, links them to the thread, and returns the reply', async () => {
    getThreadMock.mockResolvedValue({ id: 'thread-1', status: 'active' })
    cayeAgentMock.mockResolvedValue({
      replyText: 'Here you go.',
      newTurns: [{ role: 'assistant', content: [{ type: 'text', text: 'Here you go.' }] }],
      linkedThreadIds: [],
    })
    const result = await runFounderThreadTurn('ws-1', 'thread-1', 'hello')
    expect(persistAgentTurnsMock).toHaveBeenCalled()
    expect(linkMessageToThreadMock).toHaveBeenCalledWith(supabaseStub, 'thread-1', 'turn-1', 'founder')
    expect(linkMessageToThreadMock).toHaveBeenCalledWith(supabaseStub, 'thread-1', 'turn-2', 'founder')
    expect(touchThreadMock).toHaveBeenCalledWith(supabaseStub, 'thread-1')
    expect(result).toEqual({ replyText: 'Here you go.', threadId: 'thread-1' })
  })

  it('stays on the cayeAgent() path — never touches the router — when options is omitted (the voice route\'s call shape)', async () => {
    getThreadMock.mockResolvedValue({ id: 'thread-1', status: 'active' })
    await runFounderThreadTurn('ws-1', 'thread-1', 'hello')
    expect(cayeAgentMock).toHaveBeenCalled()
    expect(runCayeDirectRouterTurnMock).not.toHaveBeenCalled()
  })

  it('stays on the cayeAgent() path when requestedMode is set but founderUserId is missing (never trust a half-formed options object)', async () => {
    getThreadMock.mockResolvedValue({ id: 'thread-1', status: 'active' })
    await runFounderThreadTurn('ws-1', 'thread-1', 'hello', { requestedMode: 'auto' })
    expect(cayeAgentMock).toHaveBeenCalled()
    expect(runCayeDirectRouterTurnMock).not.toHaveBeenCalled()
  })

  it('takes the model-router path only when both requestedMode and founderUserId are present, and returns which backend served it', async () => {
    getThreadMock.mockResolvedValue({ id: 'thread-1', status: 'active' })
    const result = await runFounderThreadTurn('ws-1', 'thread-1', 'Who is Juli King?', {
      requestedMode: 'claude',
      founderUserId: 'founder-uuid-1',
    })
    expect(cayeAgentMock).not.toHaveBeenCalled()
    expect(runCayeDirectRouterTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        threadId: 'thread-1',
        founderUserId: 'founder-uuid-1',
        message: 'Who is Juli King?',
        requestedMode: 'claude',
        operatorId: 7,
      })
    )
    expect(result).toEqual({ replyText: 'Router says hi.', threadId: 'thread-1', backend: 'claude_subscription' })
  })
})

// 2026-08-17 Bimini revenue-audit incident regression suite. Caye asked for
// a comprehensive multi-customer audit; the tool loop ran out of iterations
// mid-investigation and returned a placeholder that never even persisted;
// the founder's follow-up made Caye reload the (now heavily compacted)
// thread history and describe the elision as "a platform-side caching
// issue" while asking permission to retry an already-authorized task. These
// tests exercise the fix: bounded automatic continuation, grounded on the
// investigation ledger, with no founder-facing "should I retry?" for a
// recoverable internal condition.
const toolUseTurn = (id: string, name: string, input: Record<string, unknown>) => ({
  role: 'assistant' as const,
  content: [{ type: 'tool_use' as const, id, name, input }],
})
const toolResultTurn = (id: string, payload: unknown) => ({
  role: 'user' as const,
  content: [{ type: 'tool_result' as const, tool_use_id: id, content: JSON.stringify(payload) }],
})

describe('runFounderThreadTurn — bounded investigation continuation (2026-08-17 Bimini audit fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveFounderOperatorMock.mockResolvedValue({ id: 7, name: 'Lamar', role: 'founder' })
    persistAgentTurnsMock.mockResolvedValue([{ id: 'turn-1' }, { id: 'turn-2' }])
    toolCallRows = []
    getThreadMock.mockResolvedValue({ id: 'thread-1', status: 'active' })
  })

  it('resumes automatically, with no founder-facing question, when the first pass runs out of iterations', async () => {
    const firstPassTurns = [toolUseTurn('t1', 'get_revenue', {}), toolResultTurn('t1', { ok: true })]
    const finalTurns = [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Revenue is confirmed at $9,400 across 12 bookings.' }] }]

    cayeAgentMock
      .mockResolvedValueOnce({ replyText: 'placeholder', newTurns: firstPassTurns, linkedThreadIds: [], ranOutOfIterations: true })
      .mockResolvedValueOnce({ replyText: 'Revenue is confirmed at $9,400 across 12 bookings.', newTurns: finalTurns, linkedThreadIds: [], ranOutOfIterations: false })

    const result = await runFounderThreadTurn('ws-1', 'thread-1', 'Audit Bimini revenue across every customer.')

    expect(cayeAgentMock).toHaveBeenCalledTimes(2)
    // Second call is a real continuation of the SAME investigation, not a
    // fresh request — same investigation id, isContinuation true, and the
    // original objective repeated so it can't drift.
    interface CayeAgentCallArgs {
      investigation: { id: string; isContinuation: boolean; objective: string }
    }
    const secondCallArgs = cayeAgentMock.mock.calls[1][0] as CayeAgentCallArgs
    const firstCallArgs = cayeAgentMock.mock.calls[0][0] as CayeAgentCallArgs
    expect(secondCallArgs.investigation.isContinuation).toBe(true)
    expect(secondCallArgs.investigation.id).toBe(firstCallArgs.investigation.id)
    expect(secondCallArgs.investigation.objective).toBe('Audit Bimini revenue across every customer.')

    // The founder gets the real synthesized answer, never a "should I try
    // again?" placeholder — the recovery was internal and automatic.
    expect(result.replyText).toBe('Revenue is confirmed at $9,400 across 12 bookings.')
    expect(result.replyText).not.toMatch(/do you want me to/i)
    expect(result.replyText).not.toMatch(/platform-side/i)
    expect(result.replyText).not.toMatch(/caching/i)

    // Nothing from the first pass is silently dropped — but it is persisted
    // PER PASS, immediately after each cayeAgent() call resolves, not
    // accumulated in memory and written once at the end. That's the
    // crash-recovery fix: a crash between pass 1 and pass 2 still leaves
    // pass 1's turns durable in caye_operator_messages, instead of losing
    // everything back to the start of the investigation.
    expect(persistAgentTurnsMock).toHaveBeenCalledTimes(2)
    expect(persistAgentTurnsMock).toHaveBeenNthCalledWith(
      1,
      supabaseStub,
      'ws-1',
      firstPassTurns,
      expect.anything(),
      undefined,
      undefined,
      'dashboard'
    )
    expect(persistAgentTurnsMock).toHaveBeenNthCalledWith(
      2,
      supabaseStub,
      'ws-1',
      finalTurns,
      expect.anything(),
      undefined,
      undefined,
      'dashboard'
    )
  })

  it('never calls persistAgentTurns for an empty pass — no pointless writes when a pass produced nothing new', async () => {
    cayeAgentMock.mockResolvedValueOnce({ replyText: '', newTurns: [], linkedThreadIds: [], ranOutOfIterations: false })
    await runFounderThreadTurn('ws-1', 'thread-1', 'hello')
    expect(persistAgentTurnsMock).not.toHaveBeenCalled()
  })

  it('does not continue at all when the first pass already produced a real answer', async () => {
    cayeAgentMock.mockResolvedValueOnce({ replyText: 'All caught up.', newTurns: [], linkedThreadIds: [] })
    const result = await runFounderThreadTurn('ws-1', 'thread-1', 'quick question')
    expect(cayeAgentMock).toHaveBeenCalledTimes(1)
    expect(result.replyText).toBe('All caught up.')
  })

  it('stops after MAX_INVESTIGATION_CONTINUATIONS and returns a ledger-grounded status instead of looping forever', async () => {
    // Every single call reports running out of iterations — a pathological
    // case. The loop must still terminate.
    cayeAgentMock.mockResolvedValue({
      replyText: "Sorry, that one's taking longer than it should — give me a moment and try again.",
      newTurns: [toolUseTurn('tX', 'get_customer_history', {}), toolResultTurn('tX', { ok: true })],
      linkedThreadIds: [],
      ranOutOfIterations: true,
    })
    // Seeds the real summarizeInvestigation() (see supabaseStub above) so it
    // renders exactly "- get_customer_history: 60 succeeded, 3 failed" —
    // same shape the old mocked digest asserted, now produced by the actual
    // grouping logic instead of a canned string.
    toolCallRows = [
      ...Array.from({ length: 60 }, (_, i) => ({
        tool_name: 'get_customer_history',
        status: 'SUCCESS',
        deferred: false,
        args: { conversation_id: `conv-${i}` },
        created_at: '2026-08-17T00:00:00Z',
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        tool_name: 'get_customer_history',
        status: 'FAILED',
        deferred: false,
        args: { conversation_id: `conv-failed-${i}` },
        created_at: '2026-08-17T00:00:00Z',
      })),
    ]

    const result = await runFounderThreadTurn('ws-1', 'thread-1', 'Audit every customer in depth.')

    // Bounded: exactly 1 initial call + MAX_INVESTIGATION_CONTINUATIONS continuations.
    expect(cayeAgentMock).toHaveBeenCalledTimes(1 + MAX_INVESTIGATION_CONTINUATIONS)

    // The founder is told the truth, grounded in the real ledger digest —
    // not the generic per-round placeholder, and not a fabricated number.
    expect(result.replyText).toContain('get_customer_history: 60 succeeded, 3 failed')
    expect(result.replyText).not.toBe("Sorry, that one's taking longer than it should — give me a moment and try again.")
    expect(result.replyText).toContain('Nothing here is invented')
  })

  it('never touches the investigation ledger or continuation loop on the model-router path', async () => {
    runCayeDirectRouterTurnMock.mockResolvedValue({
      replyText: 'Router answer.',
      newTurns: [],
      linkedThreadIds: [],
      backend: 'claude_subscription',
    })
    await runFounderThreadTurn('ws-1', 'thread-1', 'hello', { requestedMode: 'claude', founderUserId: 'f-1' })
    // cayeAgent is the only entry point into runInvestigation (and, in turn,
    // into summarizeInvestigation's exhaustion path) — proving it was never
    // called on the router path structurally proves the ledger was never
    // touched either.
    expect(cayeAgentMock).not.toHaveBeenCalled()
  })

  // Realistic reconstruction of the actual incident shape, with synthetic
  // (non-real) customer data standing in for what Bimini's audit pulled.
  it('completes a realistic multi-customer audit across two passes without losing any evidence or fabricating findings', async () => {
    const customers = ['Jordan Rivera', 'Casey Okafor', 'Priya Anand', 'Sam Whitfield', 'Morgan Lee']
    const firstPassTurns = [
      toolUseTurn('r1', 'get_revenue', {}),
      toolUseTurn('r2', 'get_recent_bookings', {}),
      toolResultTurn('r1', { ok: true, data: { total: 9400 } }),
      toolResultTurn('r2', { ok: true, data: { count: 12 } }),
      ...customers.flatMap((name, i) => [
        toolUseTurn(`c${i}`, 'get_customer_history', { conversation_id: `conv-${i}` }),
        toolResultTurn(`c${i}`, { ok: true, data: { name, recent_messages: [] } }),
      ]),
    ]
    const secondPassTurns = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'text' as const,
            text:
              'Revenue is $9,400 across 12 bookings this period, confirmed from get_revenue and get_recent_bookings. ' +
              `I reviewed ${customers.length} customer threads (${customers.join(', ')}). ` +
              'No payment or booking data was unconfirmed after this pass.',
          },
        ],
      },
    ]

    cayeAgentMock
      .mockResolvedValueOnce({ replyText: 'placeholder', newTurns: firstPassTurns, linkedThreadIds: [], ranOutOfIterations: true })
      .mockResolvedValueOnce({ replyText: secondPassTurns[0].content[0].text, newTurns: secondPassTurns, linkedThreadIds: [], ranOutOfIterations: false })

    const result = await runFounderThreadTurn(
      'ws-bimini',
      'thread-audit',
      'Perform a comprehensive revenue and growth audit of Bimini Island Tours across every customer thread.'
    )

    expect(cayeAgentMock).toHaveBeenCalledTimes(2)
    expect(result.replyText).toContain('$9,400')
    for (const name of customers) expect(result.replyText).toContain(name)
    // No stray "invented" framing and no confabulated infra excuse.
    expect(result.replyText).not.toMatch(/platform|caching|do you want me to try again/i)

    // Full provenance: every turn from both passes reaches persistence —
    // this is the "no silent evidence loss" assertion for the whole suite.
    // Persisted per pass (one persistAgentTurns call per cayeAgent() call),
    // not accumulated and written once — so check the union across calls.
    expect(persistAgentTurnsMock).toHaveBeenCalledTimes(2)
    const persistedTurns = persistAgentTurnsMock.mock.calls.flatMap((call) => call[2] as unknown[])
    expect(persistedTurns).toHaveLength(firstPassTurns.length + secondPassTurns.length)
    for (const t of [...firstPassTurns, ...secondPassTurns]) expect(persistedTurns).toContain(t)
  })
})
