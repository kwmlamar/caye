import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { runToolTurnWithFallback } from './tool-turn-router'
import { NoBackendAvailableError } from '../router'
import type { ToolCapableBackend, ToolTurnRequest, ToolTurnResult } from './types'
import type { BackendHealth } from '../types'

const BASE_REQ: ToolTurnRequest = {
  ctx: { founderUserId: 'lamar', threadId: 'thread-1' },
  system: 'be helpful',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  maxOutputTokens: 4096,
}

function fakeToolBackend(overrides: Partial<ToolCapableBackend> & Pick<ToolCapableBackend, 'id' | 'provider' | 'authMode' | 'capabilities'>): ToolCapableBackend {
  return {
    checkHealth: async (): Promise<BackendHealth> => ({ state: 'available', checkedAt: new Date().toISOString() }),
    invoke: async () => ({ backend: overrides.id, text: 'ok', latencyMs: 1 }),
    invokeTurn: async (): Promise<ToolTurnResult> => ({ content: [{ type: 'text', text: 'ok', citations: null }], latencyMs: 1 }),
    ...overrides,
  }
}

describe('runToolTurnWithFallback', () => {
  it('selects the first healthy backend and returns its tool-turn result', async () => {
    const claude = fakeToolBackend({ id: 'claude_subscription', provider: 'anthropic', authMode: 'subscription_cli', capabilities: ['general_reasoning'] })
    const { result, decision } = await runToolTurnWithFallback([claude], 'claude', BASE_REQ, new AbortController().signal)
    expect(result.content).toEqual([{ type: 'text', text: 'ok', citations: null }])
    expect(decision.selected).toBe('claude_subscription')
  })

  it('Auto falls back from Claude to Codex when Claude is unavailable', async () => {
    const claude = fakeToolBackend({
      id: 'claude_subscription',
      provider: 'anthropic',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'unavailable', checkedAt: new Date().toISOString() }),
    })
    const codex = fakeToolBackend({ id: 'openai_codex_subscription', provider: 'openai', authMode: 'subscription_cli', capabilities: ['general_reasoning'] })
    const { decision } = await runToolTurnWithFallback([claude, codex], 'auto', BASE_REQ, new AbortController().signal)
    expect(decision.selected).toBe('openai_codex_subscription')
    expect(decision.fallbacksTried).toEqual([{ backend: 'claude_subscription', reason: 'client_unavailable' }])
  })

  it('respects restrictToChain — used for write-pinning — ignoring the planned chain entirely', async () => {
    const claude = fakeToolBackend({ id: 'claude_subscription', provider: 'anthropic', authMode: 'subscription_cli', capabilities: ['general_reasoning'] })
    const codexInvoke = vi.fn()
    const codex = fakeToolBackend({
      id: 'openai_codex_subscription',
      provider: 'openai',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      invokeTurn: codexInvoke,
    })
    // Even though auto would normally lead with claude_subscription anyway
    // here, restrictToChain proves the planned chain is bypassed outright:
    // pin to codex only, claude must never be considered even as a fallback.
    const { decision } = await runToolTurnWithFallback(
      [claude, codex],
      'auto',
      BASE_REQ,
      new AbortController().signal,
      undefined,
      ['openai_codex_subscription']
    )
    expect(decision.chain).toEqual(['openai_codex_subscription'])
    expect(decision.selected).toBe('openai_codex_subscription')
  })

  it('throws NoBackendAvailableError when the restricted (pinned) backend is unavailable — no silent fallback to another provider', async () => {
    const claude = fakeToolBackend({
      id: 'claude_subscription',
      provider: 'anthropic',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'unavailable', checkedAt: new Date().toISOString() }),
    })
    const codexInvoke = vi.fn()
    const codex = fakeToolBackend({
      id: 'openai_codex_subscription',
      provider: 'openai',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      invokeTurn: codexInvoke,
    })
    await expect(
      runToolTurnWithFallback([claude, codex], 'auto', BASE_REQ, new AbortController().signal, undefined, ['claude_subscription'])
    ).rejects.toThrow(NoBackendAvailableError)
    expect(codexInvoke).not.toHaveBeenCalled()
  })
})
