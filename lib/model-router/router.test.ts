import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { planChain, filterByCapability, runWithFallback, NoBackendAvailableError, DEFAULT_ROUTER_POLICY } from './router'
import type { BackendHealth, ModelBackend, ModelInvokeRequest, ModelInvokeResult } from './types'

const BASE_REQ: ModelInvokeRequest = {
  ctx: { founderUserId: 'lamar', threadId: 'thread-1' },
  messages: [{ role: 'user', text: 'hi' }],
  system: 'be helpful',
}

function fakeBackend(overrides: Partial<ModelBackend> & Pick<ModelBackend, 'id' | 'provider' | 'authMode' | 'capabilities'>): ModelBackend {
  return {
    checkHealth: async (): Promise<BackendHealth> => ({ state: 'available', checkedAt: new Date().toISOString() }),
    invoke: async (): Promise<ModelInvokeResult> => ({ backend: overrides.id, text: 'ok', latencyMs: 1 }),
    ...overrides,
  }
}

describe('planChain', () => {
  it('auto + coding hint leads with the Codex subscription backend', () => {
    const chain = planChain('auto', { isCodingOrRepoTask: true })
    expect(chain[0]).toBe('openai_codex_subscription')
    expect(chain[1]).toBe('claude_subscription')
  })

  it('auto + no hints leads with the Claude subscription backend (default business-reasoning shape)', () => {
    const chain = planChain('auto', undefined)
    expect(chain[0]).toBe('claude_subscription')
    expect(chain[1]).toBe('openai_codex_subscription')
  })

  it('auto appends API backends last when allowApiFallback is true', () => {
    const chain = planChain('auto', undefined)
    expect(chain.slice(-3)).toEqual(['anthropic_api', 'openai_api', 'openrouter'])
  })

  it('auto omits API backends entirely when allowApiFallback is false', () => {
    const chain = planChain('auto', undefined, { ...DEFAULT_ROUTER_POLICY, allowApiFallback: false })
    expect(chain).not.toContain('anthropic_api')
    expect(chain).not.toContain('openai_api')
  })

  it('manual claude mode leads with claude_subscription, api fallback still available if allowed', () => {
    const chain = planChain('claude', undefined)
    expect(chain[0]).toBe('claude_subscription')
    expect(chain).toContain('anthropic_api')
  })

  it('manual openai mode leads with openai_codex_subscription', () => {
    const chain = planChain('openai', undefined)
    expect(chain[0]).toBe('openai_codex_subscription')
  })

  it('manual api mode never includes a subscription backend', () => {
    const chain = planChain('api', undefined)
    expect(chain).toEqual(['anthropic_api', 'openai_api', 'openrouter'])
  })

  it('manual api mode with allowApiFallback disabled yields an empty chain', () => {
    const chain = planChain('api', undefined, { ...DEFAULT_ROUTER_POLICY, allowApiFallback: false })
    expect(chain).toEqual([])
  })
})

describe('filterByCapability', () => {
  it('drops subscription backends when the task needs native tool_use', () => {
    const chain = filterByCapability(['claude_subscription', 'anthropic_api'], { needsToolUse: true })
    expect(chain).toEqual(['anthropic_api'])
  })

  it('keeps everything when no special capability is required', () => {
    const chain = filterByCapability(['claude_subscription', 'anthropic_api'], undefined)
    expect(chain).toEqual(['claude_subscription', 'anthropic_api'])
  })
})

describe('runWithFallback', () => {
  it('selects the first healthy backend in the chain and returns its result', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription',
      provider: 'anthropic',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
    })
    const { result, decision } = await runWithFallback([claude], 'claude', BASE_REQ, new AbortController().signal)
    expect(result.backend).toBe('claude_subscription')
    expect(decision.selected).toBe('claude_subscription')
    expect(decision.fallbacksTried).toEqual([])
  })

  it('falls back past an unhealthy backend to the next one in the chain (Claude exhausted -> OpenAI)', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription',
      provider: 'anthropic',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'quota_exhausted', checkedAt: new Date().toISOString() }),
    })
    const openai = fakeBackend({
      id: 'openai_codex_subscription',
      provider: 'openai',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
    })
    const { result, decision } = await runWithFallback(
      [claude, openai],
      'auto',
      BASE_REQ,
      new AbortController().signal
    )
    expect(result.backend).toBe('openai_codex_subscription')
    expect(decision.fallbacksTried).toEqual([{ backend: 'claude_subscription', reason: 'quota_exhausted' }])
  })

  it('falls back to the API backend when both subscription backends are unavailable and API fallback is allowed', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription',
      provider: 'anthropic',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'unavailable', checkedAt: new Date().toISOString() }),
    })
    const openai = fakeBackend({
      id: 'openai_codex_subscription',
      provider: 'openai',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'unavailable', checkedAt: new Date().toISOString() }),
    })
    const api = fakeBackend({
      id: 'anthropic_api',
      provider: 'anthropic',
      authMode: 'api_key',
      capabilities: ['general_reasoning'],
    })
    const { result } = await runWithFallback([claude, openai, api], 'auto', BASE_REQ, new AbortController().signal)
    expect(result.backend).toBe('anthropic_api')
  })

  it('throws NoBackendAvailableError truthfully when every backend is unavailable', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription',
      provider: 'anthropic',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'unavailable', checkedAt: new Date().toISOString() }),
    })
    await expect(
      runWithFallback([claude], 'claude', BASE_REQ, new AbortController().signal, { ...DEFAULT_ROUTER_POLICY, allowApiFallback: false })
    ).rejects.toThrow(NoBackendAvailableError)
  })

  it('does NOT fall back after a side-effect-tagged error — stops and surfaces it instead of retrying', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription',
      provider: 'anthropic',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      invoke: async () => {
        throw Object.assign(new Error('ambiguous — a tool call may have already sent this'), {
          sideEffectOccurred: true,
        })
      },
    })
    const openaiInvoke = vi.fn()
    const openai = fakeBackend({
      id: 'openai_codex_subscription',
      provider: 'openai',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      invoke: openaiInvoke,
    })
    await expect(runWithFallback([claude, openai], 'auto', BASE_REQ, new AbortController().signal)).rejects.toThrow(
      'a tool call may have already sent this'
    )
    expect(openaiInvoke).not.toHaveBeenCalled()
  })

  it('does NOT fall back after a malformed-request error — surfaces it instead of trying another backend', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription',
      provider: 'anthropic',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      invoke: async () => {
        throw Object.assign(new Error('bad request'), { httpStatus: 400 })
      },
    })
    const openaiInvoke = vi.fn()
    const openai = fakeBackend({
      id: 'openai_codex_subscription',
      provider: 'openai',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      invoke: openaiInvoke,
    })
    await expect(runWithFallback([claude, openai], 'auto', BASE_REQ, new AbortController().signal)).rejects.toThrow('bad request')
    expect(openaiInvoke).not.toHaveBeenCalled()
  })

  it('falls back on a retryable invoke() throw (rate limited) to the next backend', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription',
      provider: 'anthropic',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      invoke: async () => {
        throw Object.assign(new Error('rate limited'), { httpStatus: 429 })
      },
    })
    const openai = fakeBackend({
      id: 'openai_codex_subscription',
      provider: 'openai',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
    })
    const { result, decision } = await runWithFallback([claude, openai], 'auto', BASE_REQ, new AbortController().signal)
    expect(result.backend).toBe('openai_codex_subscription')
    expect(decision.fallbacksTried).toEqual([{ backend: 'claude_subscription', reason: 'rate_limited' }])
  })
})
