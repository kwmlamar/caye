import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const buildBackOfficeTurnContextMock = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ systemPrompt: 'SYSTEM', initialMessages: [{ role: 'user', content: 'Who is Juli King?' }] })
)
vi.mock('@/lib/caye-agent', () => ({
  buildBackOfficeTurnContext: (...args: unknown[]) => buildBackOfficeTurnContextMock(...args),
}))

const runFounderToolLoopMock = vi.fn((..._args: unknown[]) =>
  Promise.resolve({
    replyText: 'Juli King — juli.whaley@yahoo.com.',
    newTurns: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    linkedThreadIds: ['thread-1'],
    decision: { requestedMode: 'auto', chain: ['claude_subscription', 'anthropic_api'], selected: 'claude_subscription', fallbacksTried: [] },
  })
)
vi.mock('./tool-bridge/founder-tool-loop', () => ({
  runFounderToolLoop: (...args: unknown[]) => runFounderToolLoopMock(...args),
  ProtocolViolationError: class ProtocolViolationError extends Error {},
}))

import { runCayeDirectRouterTurn } from './caye-direct-bridge'

const BASE_ARGS = {
  workspaceId: 'ws-1',
  threadId: 'thread-1',
  founderUserId: 'founder-uuid-1',
  callerName: 'Lamar',
  operatorId: 7,
  message: 'Who is Juli King?',
  requestedMode: 'auto' as const,
}

describe('runCayeDirectRouterTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    buildBackOfficeTurnContextMock.mockResolvedValue({
      systemPrompt: 'SYSTEM',
      initialMessages: [{ role: 'user', content: 'Who is Juli King?' }],
    })
    runFounderToolLoopMock.mockResolvedValue({
      replyText: 'Juli King — juli.whaley@yahoo.com.',
      newTurns: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
      linkedThreadIds: ['thread-1'],
      decision: { requestedMode: 'auto', chain: ['claude_subscription', 'anthropic_api'], selected: 'claude_subscription', fallbacksTried: [] },
    })
  })

  it('builds the SAME back-office context (system + history) the production cayeAgent() path uses', async () => {
    await runCayeDirectRouterTurn(BASE_ARGS)
    expect(buildBackOfficeTurnContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'back-office',
        workspaceId: 'ws-1',
        userMessage: 'Who is Juli King?',
        callerRole: 'founder',
        callerName: 'Lamar',
        operatorId: 7,
        threadId: 'thread-1',
      })
    )
  })

  function firstCallArg(): {
    ctx: unknown
    requestedMode: unknown
    backends: { id: string }[]
    hints: unknown
    restrictToToolNames: unknown
    toolCtx: { directThreadLinks: string[] }
  } {
    return runFounderToolLoopMock.mock.calls[0][0] as ReturnType<typeof firstCallArg>
  }

  it('passes a FounderRouterContext scoped to this thread and the verified founder id — never request-body-sourced', async () => {
    await runCayeDirectRouterTurn(BASE_ARGS)
    const call = firstCallArg()
    expect(call.ctx).toEqual({ founderUserId: 'founder-uuid-1', threadId: 'thread-1', workspaceId: 'ws-1' })
    expect(call.requestedMode).toBe('auto')
  })

  it('registers exactly the three real backends — claude_subscription, openai_codex_subscription, anthropic_api — and invents no openai_api class', async () => {
    await runCayeDirectRouterTurn(BASE_ARGS)
    const ids = firstCallArg().backends.map((b) => b.id)
    expect(ids).toEqual(['claude_subscription', 'openai_codex_subscription', 'anthropic_api'])
  })

  it('never sets hints.needsToolUse — would silently filter subscription backends out of an Auto chain (see capabilities.ts)', async () => {
    await runCayeDirectRouterTurn(BASE_ARGS)
    expect(firstCallArg().hints).toBeUndefined()
  })

  it('does not set restrictToToolNames — real integration exposes the full back-office tool set, same as cayeAgent()', async () => {
    await runCayeDirectRouterTurn(BASE_ARGS)
    expect(firstCallArg().restrictToToolNames).toBeUndefined()
  })

  it('returns replyText/newTurns/linkedThreadIds/backend shaped like CayeAgentResult plus backend', async () => {
    const result = await runCayeDirectRouterTurn(BASE_ARGS)
    expect(result).toEqual({
      replyText: 'Juli King — juli.whaley@yahoo.com.',
      newTurns: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
      linkedThreadIds: ['thread-1'],
      backend: 'claude_subscription',
    })
  })

  it('propagates a thrown error (e.g. NoBackendAvailableError / ProtocolViolationError) rather than swallowing it into a fabricated reply', async () => {
    runFounderToolLoopMock.mockRejectedValue(new Error('No reasoning backend is currently available.'))
    await expect(runCayeDirectRouterTurn(BASE_ARGS)).rejects.toThrow('No reasoning backend is currently available.')
  })

  it('passes a fresh, empty directThreadLinks array per call (no leakage across turns)', async () => {
    await runCayeDirectRouterTurn(BASE_ARGS)
    await runCayeDirectRouterTurn({ ...BASE_ARGS, message: 'second turn' })
    const firstToolCtx = firstCallArg().toolCtx
    const secondToolCtx = (runFounderToolLoopMock.mock.calls[1][0] as ReturnType<typeof firstCallArg>).toolCtx
    expect(firstToolCtx.directThreadLinks).not.toBe(secondToolCtx.directThreadLinks)
  })
})
