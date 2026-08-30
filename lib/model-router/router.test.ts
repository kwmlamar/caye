import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { planChain, filterByCapability, runWithFallback, DEFAULT_ROUTER_POLICY } from './router'
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
  it('auto keeps subscription backends first and cheaper OpenAI API first in the metered tail', () => {
    expect(planChain('auto', undefined)).toEqual([
      'claude_subscription',
      'openai_codex_subscription',
      'openai_api',
      'anthropic_api',
      'openrouter',
    ])
  })

  it('coding tasks still lead with Codex subscription', () => {
    expect(planChain('auto', { isCodingOrRepoTask: true })[0]).toBe('openai_codex_subscription')
  })

  it('strongest/long-context shapes preserve Anthropic-first metered ordering', () => {
    expect(planChain('auto', { preferStrongest: true }).slice(-3)).toEqual(['anthropic_api', 'openai_api', 'openrouter'])
    expect(planChain('api', { needsLongContext: true })).toEqual(['anthropic_api', 'openai_api', 'openrouter'])
  })

  it('manual provider modes prefer their matching provider', () => {
    expect(planChain('claude', undefined).slice(0, 2)).toEqual(['claude_subscription', 'anthropic_api'])
    expect(planChain('openai', undefined).slice(0, 2)).toEqual(['openai_codex_subscription', 'openai_api'])
  })

  it('explicit api mode always remains available', () => {
    expect(planChain('api', undefined)).toEqual(['openai_api', 'anthropic_api', 'openrouter'])
    expect(planChain('api', undefined, { ...DEFAULT_ROUTER_POLICY, allowApiFallback: false })).toEqual([
      'openai_api',
      'anthropic_api',
      'openrouter',
    ])
  })

  it('callers can disable automatic metered fallback without disabling explicit api mode', () => {
    const policy = { ...DEFAULT_ROUTER_POLICY, allowApiFallback: false }
    expect(planChain('auto', undefined, policy)).toEqual(['claude_subscription', 'openai_codex_subscription'])
    expect(planChain('claude', undefined, policy)).toEqual(['claude_subscription'])
    expect(planChain('openai', undefined, policy)).toEqual(['openai_codex_subscription'])
  })
})

describe('filterByCapability', () => {
  it('drops backends that cannot satisfy required capabilities', () => {
    expect(filterByCapability(['claude_subscription', 'anthropic_api'], { needsToolUse: true })).toEqual(['anthropic_api'])
  })
})

describe('runWithFallback', () => {
  it('selects the first healthy backend', async () => {
    const claude = fakeBackend({ id: 'claude_subscription', provider: 'anthropic', authMode: 'subscription_cli', capabilities: ['general_reasoning'] })
    const { result } = await runWithFallback([claude], 'claude', BASE_REQ, new AbortController().signal)
    expect(result.backend).toBe('claude_subscription')
  })

  it('falls through unavailable cloud subscription backends to OpenAI API by default', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription', provider: 'anthropic', authMode: 'subscription_cli', capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'unavailable', checkedAt: new Date().toISOString() }),
    })
    const codex = fakeBackend({
      id: 'openai_codex_subscription', provider: 'openai', authMode: 'subscription_cli', capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'unavailable', checkedAt: new Date().toISOString() }),
    })
    const openaiApi = fakeBackend({ id: 'openai_api', provider: 'openai', authMode: 'api_key', capabilities: ['general_reasoning'] })
    const { result } = await runWithFallback([claude, codex, openaiApi], 'auto', BASE_REQ, new AbortController().signal)
    expect(result.backend).toBe('openai_api')
  })

  it('respects allowApiFallback:false for automatic fallback', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription', provider: 'anthropic', authMode: 'subscription_cli', capabilities: ['general_reasoning'],
      checkHealth: async () => ({ state: 'unavailable', checkedAt: new Date().toISOString() }),
    })
    const apiInvoke = vi.fn(async (): Promise<ModelInvokeResult> => ({ backend: 'openai_api', text: 'paid', latencyMs: 1 }))
    const api = fakeBackend({ id: 'openai_api', provider: 'openai', authMode: 'api_key', capabilities: ['general_reasoning'], invoke: apiInvoke })
    await expect(
      runWithFallback([claude, api], 'claude', BASE_REQ, new AbortController().signal, { ...DEFAULT_ROUTER_POLICY, allowApiFallback: false })
    ).rejects.toThrow()
    expect(apiInvoke).not.toHaveBeenCalled()
  })

  it('does not cross-provider fallback after a side effect may have occurred', async () => {
    const claude = fakeBackend({
      id: 'claude_subscription', provider: 'anthropic', authMode: 'subscription_cli', capabilities: ['general_reasoning'],
      invoke: async () => { throw Object.assign(new Error('ambiguous send'), { sideEffectOccurred: true }) },
    })
    const openaiInvoke = vi.fn()
    const openai = fakeBackend({ id: 'openai_codex_subscription', provider: 'openai', authMode: 'subscription_cli', capabilities: ['general_reasoning'], invoke: openaiInvoke })
    await expect(runWithFallback([claude, openai], 'auto', BASE_REQ, new AbortController().signal)).rejects.toThrow('ambiguous send')
    expect(openaiInvoke).not.toHaveBeenCalled()
  })
})
