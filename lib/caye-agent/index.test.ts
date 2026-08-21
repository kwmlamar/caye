import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

// Minimal `customers` table stub — index.ts's buildBackOfficeTurnContext
// reads business_brief/voice-profile fields directly (not through
// context.ts), independent of everything else under test here.
const supabaseStub = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      }),
    }),
  }),
}
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => supabaseStub,
}))

vi.mock('@/lib/owner-attention', () => ({
  loadAttentionDelta: async () => ({}),
  renderAttentionContext: () => '',
}))
vi.mock('@/lib/owner-attention-sync', () => ({
  syncOwnerAttention: async () => {},
}))

const loadOperatorContextMock = vi.fn((..._args: unknown[]) => Promise.resolve([]))
const loadDirectThreadContextMock = vi.fn((..._args: unknown[]) =>
  Promise.resolve({
    history: [{ role: 'user', content: 'stale compacted history — must never reach a continuation pass' }],
    promptBlock: 'thread promptBlock',
  })
)
vi.mock('./context', () => ({
  loadOperatorContext: (...args: unknown[]) => loadOperatorContextMock(...args),
  loadDirectThreadContext: (...args: unknown[]) => loadDirectThreadContextMock(...args),
}))

vi.mock('./modes/back-office', () => ({
  buildBackOfficeSystemPrompt: () => 'system prompt',
}))
vi.mock('./modes/driver', () => ({ buildDriverSystemPrompt: () => 'driver prompt' }))
vi.mock('./modes/admin-shell', () => ({ buildAdminShellSystemPrompt: () => 'admin prompt' }))
vi.mock('./admin-shell-context', () => ({ loadAdminShellContext: async () => [] }))

const runToolLoopMock = vi.fn((..._args: unknown[]) =>
  Promise.resolve({
    replyText: 'ok',
    newTurns: [] as unknown[],
    linkedThreadIds: [] as string[],
    ranOutOfIterations: false,
  })
)
vi.mock('./execute', () => ({
  runToolLoop: (...args: unknown[]) => runToolLoopMock(...args),
}))

const summarizeInvestigationMock = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ totalCalls: 0, summaryText: '', coveredSubjects: [] as string[] })
)
vi.mock('./investigation', () => ({
  summarizeInvestigation: (...args: unknown[]) => summarizeInvestigationMock(...args),
  buildContinuationPrompt: (objective: string) => `CONTINUATION PROMPT for: ${objective}`,
}))

import { cayeAgent, buildBackOfficeTurnContext } from './index'

describe('cayeAgent / buildBackOfficeTurnContext — investigation continuation isolation (2026-08-17 Bimini audit fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runToolLoopMock.mockResolvedValue({ replyText: 'ok', newTurns: [], linkedThreadIds: [], ranOutOfIterations: false })
    summarizeInvestigationMock.mockResolvedValue({ totalCalls: 0, summaryText: '', coveredSubjects: [] })
  })

  it('an ordinary (non-continuation) turn loads real thread history and does NOT set readOnly', async () => {
    await cayeAgent({
      mode: 'back-office',
      workspaceId: 'ws-1',
      userMessage: 'what happened with Kenneth?',
      callerRole: 'founder',
      operatorId: 7,
      threadId: 'thread-1',
    })

    expect(loadDirectThreadContextMock).toHaveBeenCalledWith('ws-1', 'thread-1')
    expect(runToolLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: false }),
    )
    const initialMessages = (runToolLoopMock.mock.calls[0][0] as { initialMessages: Array<{ content: unknown }> }).initialMessages
    // The real (possibly compacted) thread history is what an ordinary turn uses.
    expect(JSON.stringify(initialMessages)).toContain('stale compacted history')
  })

  it('a continuation pass NEVER calls loadDirectThreadContext — proves independence from history-compaction.ts', async () => {
    await cayeAgent({
      mode: 'back-office',
      workspaceId: 'ws-1',
      userMessage: 'ignored on a continuation',
      callerRole: 'founder',
      operatorId: 7,
      threadId: 'thread-1',
      investigation: { id: 'inv-1', isContinuation: true, objective: 'Audit everything.' },
    })

    expect(loadDirectThreadContextMock).not.toHaveBeenCalled()
  })

  it('a continuation pass builds its initial message from the ledger digest, not from any conversation replay', async () => {
    summarizeInvestigationMock.mockResolvedValue({
      totalCalls: 12,
      summaryText: '- get_customer_history: 12 succeeded',
      coveredSubjects: [],
    })
    await cayeAgent({
      mode: 'back-office',
      workspaceId: 'ws-1',
      userMessage: 'ignored on a continuation',
      callerRole: 'founder',
      operatorId: 7,
      threadId: 'thread-1',
      investigation: { id: 'inv-1', isContinuation: true, objective: 'Audit everything.' },
    })

    const initialMessages = (runToolLoopMock.mock.calls[0][0] as { initialMessages: Array<{ content: unknown }> }).initialMessages
    expect(initialMessages).toHaveLength(1)
    expect(initialMessages[0].content).toBe('CONTINUATION PROMPT for: Audit everything.')
    expect(JSON.stringify(initialMessages)).not.toContain('stale compacted history')
  })

  it('a continuation pass sets readOnly: true on the tool loop — structural exclusion of write tools', async () => {
    await cayeAgent({
      mode: 'back-office',
      workspaceId: 'ws-1',
      userMessage: 'ignored',
      callerRole: 'founder',
      operatorId: 7,
      threadId: 'thread-1',
      investigation: { id: 'inv-1', isContinuation: true, objective: 'Audit everything.' },
    })
    expect(runToolLoopMock).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }))
  })

  it('the FIRST pass of an investigation (isContinuation: false) is NOT read-only', async () => {
    await cayeAgent({
      mode: 'back-office',
      workspaceId: 'ws-1',
      userMessage: 'Audit everything.',
      callerRole: 'founder',
      operatorId: 7,
      threadId: 'thread-1',
      investigation: { id: 'inv-1', isContinuation: false, objective: 'Audit everything.' },
    })
    expect(runToolLoopMock).toHaveBeenCalledWith(expect.objectContaining({ readOnly: false }))
  })

  it('scopes summarizeInvestigation to this call\'s workspaceId, not just the investigation id', async () => {
    await cayeAgent({
      mode: 'back-office',
      workspaceId: 'ws-bimini',
      userMessage: 'ignored',
      callerRole: 'founder',
      operatorId: 7,
      threadId: 'thread-1',
      investigation: { id: 'inv-1', isContinuation: true, objective: 'Audit everything.' },
    })
    expect(summarizeInvestigationMock).toHaveBeenCalledWith(supabaseStub, 'inv-1', 'ws-bimini')
  })

  it('threads investigationId through to ToolContext so caye_tool_calls can be grouped by it', async () => {
    await cayeAgent({
      mode: 'back-office',
      workspaceId: 'ws-1',
      userMessage: 'Audit everything.',
      callerRole: 'founder',
      operatorId: 7,
      threadId: 'thread-1',
      investigation: { id: 'inv-xyz', isContinuation: false, objective: 'Audit everything.' },
    })
    expect(runToolLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: expect.objectContaining({ investigationId: 'inv-xyz' }) })
    )
  })

  it('leaves investigationId null on an ordinary turn with no investigation', async () => {
    await cayeAgent({
      mode: 'back-office',
      workspaceId: 'ws-1',
      userMessage: 'hi',
      callerRole: 'founder',
      operatorId: 7,
    })
    expect(runToolLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: expect.objectContaining({ investigationId: null }) })
    )
  })

  it('propagates ranOutOfIterations from runToolLoop up through cayeAgent\'s result', async () => {
    runToolLoopMock.mockResolvedValue({ replyText: 'placeholder', newTurns: [], linkedThreadIds: [], ranOutOfIterations: true })
    const result = await cayeAgent({
      mode: 'back-office',
      workspaceId: 'ws-1',
      userMessage: 'Audit everything.',
      callerRole: 'founder',
      operatorId: 7,
      investigation: { id: 'inv-1', isContinuation: false, objective: 'Audit everything.' },
    })
    expect(result.ranOutOfIterations).toBe(true)
  })
})

describe('buildBackOfficeTurnContext — direct verification (used by both cayeAgent and the model-router bridge)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    summarizeInvestigationMock.mockResolvedValue({ totalCalls: 0, summaryText: '', coveredSubjects: [] })
  })

  it('never invokes loadDirectThreadContext when isContinuation is true, even with a threadId set', async () => {
    await buildBackOfficeTurnContext({
      mode: 'back-office',
      workspaceId: 'ws-1',
      userMessage: 'ignored',
      callerRole: 'founder',
      operatorId: 7,
      threadId: 'thread-1',
      investigation: { id: 'inv-1', isContinuation: true, objective: 'Audit everything.' },
    })
    expect(loadDirectThreadContextMock).not.toHaveBeenCalled()
  })
})
