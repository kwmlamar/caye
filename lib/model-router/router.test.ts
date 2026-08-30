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
    expect(chain).toEqual(['openai_codex_subscription', 'claude_subscription'])
  })

  it('auto defaults to subscription-only so an outage cannot silently spend API money', () => {
    expect(planChain('auto', undefined)).toEqual(['claude_subscription', 'openai_codex_subscription'])
  })

  it('auto adds lower-cost OpenAI first only when metered fallback is explicitly enabled', () => {
    const chain = planChain('auto', undefined, { ...DEFAULT_ROUTER_POLICY, allowApiFallback: true })
    expect(chain).toEqual([
      'claude_subscription',
      'openai_codex_subscription',
      'openai_api',
      'anthropic_api',
      'openrouter',
    ])
  })

  it('strongest/long-context shapes preserve Anthropic-first metered ordering when fallback is enabled', () => {
    const policy = { ...DEFAULT_ROUTER_POLICY, allowApiFallback: true }
    expect(planChain('auto', { preferStrongest: true }, policy).slice(-3)).toEqual([
      'anthropic_api',
      'openai_api',
      'openrouter',
    ])
    expect(planChain('api', { needsLongContext: true })).toEqual(['anthropic_api', 'openai_api', 'openrouter'])
  })

  it('manual claude/openai modes do not spill to API by default', () => {
    expect(planChain('claude', undefined)).toEqual(['claude_subscription'])
    expect(planChain('openai', undefined)).toEqual(['openai_codex_subscription'])
  })

  it('manual provider modes may use same-provider API when fallback is explicitly enabled', () => {
    const policy = { ...DEFAULT_ROUTER_POLICY, allowApiFallback: true }
    expect(planChain('claude', undefined, policy)[1]).toBe('anthropic_api')
    expect(planChain('openai', undefined, policy)[1]).toBe('openai_api')
  })

  it('explicit api mode remains available even when fallback is disabled', () => {
    expect(planChain('api', undefined)).toEqual(['openai_api', 'anthropic_api', 'openrouter'])
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

  it('falls back between subscription backends without enabling metered fallback', async () => {
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
    const { result, decision } = await runWithFallback([claude, openai], 'auto', BASE_REQ, new AbortController().signal)
    expect(result.backend).toBe('openai_codex_subscription')
    expect(decision.fallbacksTried).toEqual([{ backend: 'claude_subscription', reason: 'quota_exhausted' }])
  })

  it('does not silently spill into a healthy API backend when subscriptions are unavailable', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription',
      provider: 'anthropic',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'unavailable', checkedAt: new Date().toISOString() }),
    })
    const codex = fakeBackend({
      id: 'openai_codex_subscription',
      provider: 'openai',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'unavailable', checkedAt: new Date().toISOString() }),
    })
    const apiInvoke = vi.fn(async (): Promise<ModelInvokeResult> => ({ backend: 'openai_api', text: 'paid', latencyMs: 1 }))
    const api = fakeBackend({
      id: 'openai_api',
      provider: 'openai',
      authMode: 'api_key',
      capabilities: ['general_reasoning'],
      invoke: apiInvoke,
    })

    await expect(runWithFallback([claude, codex, api], 'auto', BASE_REQ, new AbortController().signal)).rejects.toThrow(
      NoBackendAvailableError
    )
    expect(apiInvoke).not.toHaveBeenCalled()
  })

  it('can use a metered backend when fallback is explicitly enabled', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription',
      provider: 'anthropic',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'unavailable', checkedAt: new Date().toISOString() }),
    })
    const codex = fakeBackend({
      id: 'openai_codex_subscription',
      provider: 'openai',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'unavailable', checkedAt: new Date().toISOString() }),
    })
    const api = fakeBackend({
      id: 'openai_api',
      provider: 'openai',
      authMode: 'api_key',
      capabilities: ['general_reasoning'],
    })
    const { result } = await runWithFallback(
      [claude, codex, api],
      'auto',
      BASE_REQ,
      new AbortController().signal,
      { ...DEFAULT_ROUTER_POLICY, allowApiFallback: true }
    )
    expect(result.backend).toBe('openai_api')
  })

  it('does NOT fall back after a side-effect-tagged error', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription',
      provider: 'anthropic',
      authMode: 'subscription_cli',
      capabilities: ['general_reasoning'],
      invoke: async () => {
        throw Object.assign(new Error('ambiguous — a tool call may have already sent this'), { sideEffectOccurred: true })
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

  it('does NOT fall back after a malformed-request error', async () => {
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

  it('falls back on a retryable invoke() throw to the next subscription backend', async () => {
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
