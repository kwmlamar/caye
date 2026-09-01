import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * Supabase stub. The gateway reads provider health + settings and writes
 * telemetry; none of that may be a hard dependency of serving a request, so
 * these tests also double as the fail-open proof.
 */
const healthRows: Record<string, unknown>[] = []
const settingsRows: Record<string, unknown>[] = []
const inserted: Record<string, unknown>[] = []
const upserted: Record<string, unknown>[] = []
let selectShouldThrow = false

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      return {
        select: async () => {
          if (selectShouldThrow) return { data: null, error: new Error('db down') }
          return { data: table === 'ai_provider_health' ? healthRows : settingsRows, error: null }
        },
        insert: async (row: Record<string, unknown>) => {
          inserted.push({ table, ...row })
          return { error: null }
        },
        upsert: async (row: Record<string, unknown>) => {
          upserted.push({ table, ...row })
          return { error: null }
        },
      }
    },
  }),
}))

const { generate } = await import('./gateway')
const { setProviderAdapters } = await import('./providers')
const { resetHealthCache } = await import('./health')
const { resetProviderSettingsCache } = await import('./provider-settings')
const { FakeProvider, httpError } = await import('./test-support')
type FakeProvider = InstanceType<typeof FakeProvider>
const { NoAIProviderAvailableError, AIProviderError } = await import('./types')

let restore: (() => void) | null = null

function install(providers: { anthropic?: FakeProvider; openai?: FakeProvider; openrouter?: FakeProvider }) {
  restore?.()
  restore = setProviderAdapters({
    anthropic: providers.anthropic ?? new FakeProvider('anthropic'),
    openai: providers.openai ?? new FakeProvider('openai'),
    openrouter: providers.openrouter ?? new FakeProvider('openrouter'),
  })
}

const params = { model: 'ignored', max_tokens: 100, messages: [{ role: 'user' as const, content: 'hi' }] }
const ctx = { source: 'test', task: 'customer_response' as const, workspaceId: 'ws-1' }

beforeEach(() => {
  healthRows.length = 0
  settingsRows.length = 0
  inserted.length = 0
  upserted.length = 0
  selectShouldThrow = false
  resetHealthCache()
  resetProviderSettingsCache()
  vi.unstubAllEnvs()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  restore?.()
  restore = null
  vi.restoreAllMocks()
})

describe('routing', () => {
  it('serves from the first eligible provider and reports no fallback', async () => {
    const anthropic = new FakeProvider('anthropic')
    install({ anthropic })

    const result = await generate({ params, ctx })

    expect(result.routing.provider).toBe('anthropic')
    expect(result.routing.fellBack).toBe(false)
    expect(result.routing.attempts).toEqual([
      expect.objectContaining({ provider: 'anthropic', outcome: 'success' }),
    ])
    expect(anthropic.calls).toHaveLength(1)
  })

  it('falls over to OpenAI when Anthropic is unavailable', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [httpError(503, 'upstream unavailable')] }),
    })

    const result = await generate({ params, ctx })

    expect(result.routing.provider).toBe('openai')
    expect(result.routing.fellBack).toBe(true)
    expect(result.routing.attempts.map((a) => a.outcome)).toEqual(['upstream_5xx', 'success'])
  })

  it('falls all the way through to OpenRouter', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [httpError(500, 'boom')] }),
      openai: new FakeProvider('openai', { behaviour: [httpError(500, 'boom')] }),
    })

    const result = await generate({ params, ctx })

    expect(result.routing.provider).toBe('openrouter')
    expect(result.routing.attempts.map((a) => a.provider)).toEqual(['anthropic', 'openai', 'openrouter'])
  })

  it('skips a provider the founder disabled', async () => {
    settingsRows.push({ provider: 'anthropic', enabled: false, priority: null })
    const anthropic = new FakeProvider('anthropic')
    install({ anthropic })

    const result = await generate({ params, ctx })

    expect(result.routing.provider).toBe('openai')
    expect(anthropic.calls).toHaveLength(0)
    expect(result.routing.attempts[0]).toMatchObject({ provider: 'anthropic', outcome: 'skipped_disabled' })
  })

  it('skips a provider with no credentials without spending a request', async () => {
    const anthropic = new FakeProvider('anthropic', { hasKey: false })
    install({ anthropic })

    const result = await generate({ params, ctx })

    expect(result.routing.provider).toBe('openai')
    expect(anthropic.calls).toHaveLength(0)
    expect(result.routing.attempts[0]).toMatchObject({ outcome: 'skipped_no_credentials' })
  })

  it('skips a model that cannot serve a required capability', async () => {
    const anthropic = new FakeProvider('anthropic', { capabilities: [] })
    install({ anthropic })

    const withTools = {
      ...params,
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object' as const, properties: {} } }],
    }
    const result = await generate({ params: withTools, ctx })

    expect(result.routing.provider).toBe('openai')
    expect(result.routing.attempts[0]).toMatchObject({ outcome: 'skipped_capability' })
    expect(anthropic.calls).toHaveLength(0)
  })

  it('honours an explicit provider pin instead of failing over', async () => {
    install({ anthropic: new FakeProvider('anthropic', { behaviour: [httpError(500, 'boom')] }) })

    await expect(generate({ params, ctx: { ...ctx, pinProvider: 'anthropic' } })).rejects.toBeInstanceOf(
      NoAIProviderAvailableError
    )
  })

  it('routes cheap tasks to the cheap tier', async () => {
    const anthropic = new FakeProvider('anthropic')
    install({ anthropic })

    const result = await generate({ params, ctx: { source: 'test', task: 'classification' } })

    expect(result.routing.model).toBe('claude-haiku-4-5-20251001')
  })

  it('reorders providers from CAYE_AI_PROVIDER_ORDER without inventing routes', async () => {
    vi.stubEnv('CAYE_AI_PROVIDER_ORDER', 'openrouter,openai,anthropic')
    install({})

    const result = await generate({ params, ctx })

    expect(result.routing.provider).toBe('openrouter')
  })
})

describe('failure behaviour', () => {
  it('treats an Anthropic billing 400 as an availability failure and fails over', async () => {
    // Live-observed shape: exhausted balance returns HTTP 400, not 402/429.
    const anthropic = new FakeProvider('anthropic', {
      behaviour: [httpError(400, 'Your credit balance is too low to access the Anthropic API.')],
    })
    install({ anthropic })

    const result = await generate({ params, ctx })

    expect(result.routing.attempts[0].outcome).toBe('billing_exhausted')
    expect(result.routing.provider).toBe('openai')
  })

  it('retries a rate limit once on the same provider before failing over', async () => {
    const anthropic = new FakeProvider('anthropic', {
      behaviour: [httpError(429, 'rate limit'), 'ok'],
    })
    install({ anthropic })

    const result = await generate({ params, ctx })

    expect(anthropic.calls).toHaveLength(2)
    expect(result.routing.provider).toBe('anthropic')
    expect(result.routing.fellBack).toBe(false)
  })

  it('fails over when the bounded rate-limit retry also fails', async () => {
    const anthropic = new FakeProvider('anthropic', {
      behaviour: [httpError(429, 'rate limit'), httpError(429, 'rate limit'), httpError(429, 'rate limit')],
    })
    install({ anthropic })

    const result = await generate({ params, ctx })

    expect(anthropic.calls).toHaveLength(2)
    expect(result.routing.provider).toBe('openai')
  })

  it('fails over on timeout', async () => {
    install({ anthropic: new FakeProvider('anthropic', { behaviour: [Object.assign(new Error('x'), { name: 'AbortError' })] }) })
    const result = await generate({ params, ctx })
    expect(result.routing.attempts[0].outcome).toBe('timeout')
    expect(result.routing.provider).toBe('openai')
  })

  it('fails over on a network error', async () => {
    install({ anthropic: new FakeProvider('anthropic', { behaviour: [new Error('fetch failed')] }) })
    const result = await generate({ params, ctx })
    expect(result.routing.attempts[0].outcome).toBe('network')
    expect(result.routing.provider).toBe('openai')
  })

  it('does NOT fan a malformed request out to every provider', async () => {
    const anthropic = new FakeProvider('anthropic', { behaviour: [httpError(400, 'messages: unexpected role')] })
    const openai = new FakeProvider('openai')
    const openrouter = new FakeProvider('openrouter')
    install({ anthropic, openai, openrouter })

    await expect(generate({ params, ctx })).rejects.toMatchObject({ category: 'malformed_request' })
    expect(openai.calls).toHaveLength(0)
    expect(openrouter.calls).toHaveLength(0)
  })

  it('does NOT fan an invalid tool schema out to every provider', async () => {
    const openai = new FakeProvider('openai')
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [httpError(400, 'tools.0.input_schema: invalid schema')] }),
      openai,
    })

    await expect(generate({ params, ctx })).rejects.toMatchObject({ category: 'invalid_tool_or_schema' })
    expect(openai.calls).toHaveLength(0)
  })

  it('returns one normalized error when every provider fails', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [httpError(500, 'a')] }),
      openai: new FakeProvider('openai', { behaviour: [httpError(500, 'b')] }),
      openrouter: new FakeProvider('openrouter', { behaviour: [httpError(500, 'c')] }),
    })

    const error = await generate({ params, ctx }).catch((e) => e)

    expect(error).toBeInstanceOf(NoAIProviderAvailableError)
    expect(error.attempts).toHaveLength(3)
    expect(error.message).toContain('All AI providers failed')
  })

  it('surfaces a clear error when no provider is configured at all', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { hasKey: false }),
      openai: new FakeProvider('openai', { hasKey: false }),
      openrouter: new FakeProvider('openrouter', { hasKey: false }),
    })

    const error = await generate({ params, ctx }).catch((e) => e)

    expect(error).toBeInstanceOf(NoAIProviderAvailableError)
    expect(error.attempts.every((a: { outcome: string }) => a.outcome === 'skipped_no_credentials')).toBe(true)
  })
})

describe('configuration validity', () => {
  it('stays functional when ANTHROPIC_API_KEY is absent but OpenAI is configured', async () => {
    install({ anthropic: new FakeProvider('anthropic', { hasKey: false }) })
    const result = await generate({ params, ctx })
    expect(result.routing.provider).toBe('openai')
  })

  it('stays functional when only OpenRouter is configured', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { hasKey: false }),
      openai: new FakeProvider('openai', { hasKey: false }),
    })
    const result = await generate({ params, ctx })
    expect(result.routing.provider).toBe('openrouter')
  })
})

describe('resilience of the gateway itself', () => {
  it('serves requests when the health/settings store is unreachable', async () => {
    selectShouldThrow = true
    install({})

    const result = await generate({ params, ctx })

    expect(result.routing.provider).toBe('anthropic')
  })
})

describe('telemetry', () => {
  it('records provider, task, fallback and the full attempt trail', async () => {
    install({ anthropic: new FakeProvider('anthropic', { behaviour: [httpError(500, 'boom')] }) })

    await generate({ params, ctx })
    await new Promise((r) => setTimeout(r, 0))

    const row = inserted.find((r) => r.table === 'llm_call_log')
    expect(row).toMatchObject({
      provider: 'openai',
      task: 'customer_response',
      outcome: 'success',
      fallback_used: true,
      workspace_id: 'ws-1',
      source: 'test',
    })
    expect(Array.isArray(row!.attempts)).toBe(true)
    expect((row!.attempts as unknown[]).length).toBe(2)
  })

  it('records a failed call so a total outage is visible, not silent', async () => {
    install({
      anthropic: new FakeProvider('anthropic', { behaviour: [httpError(500, 'a')] }),
      openai: new FakeProvider('openai', { behaviour: [httpError(500, 'b')] }),
      openrouter: new FakeProvider('openrouter', { behaviour: [httpError(500, 'c')] }),
    })

    await generate({ params, ctx }).catch(() => {})
    await new Promise((r) => setTimeout(r, 0))

    expect(inserted.find((r) => r.outcome === 'failure')).toMatchObject({ failure_category: 'upstream_5xx' })
  })

  it('reports usage and computed cost for the serving provider', async () => {
    install({})
    const result = await generate({ params, ctx })
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)
    expect(result.usage.costUsd).toBeGreaterThan(0)
  })
})

describe('safety invariants', () => {
  it('passes the caller request through unchanged — routing never edits prompts', async () => {
    const anthropic = new FakeProvider('anthropic')
    install({ anthropic })

    const system = 'You are Caye.'
    await generate({ params: { ...params, system }, ctx })

    expect(anthropic.calls[0].params.system).toBe(system)
    expect(anthropic.calls[0].params.messages).toEqual(params.messages)
  })

  it('does not fail over when a side effect may already have occurred', async () => {
    const openai = new FakeProvider('openai')
    install({
      anthropic: new FakeProvider('anthropic', {
        behaviour: [new AIProviderError('side_effect_may_have_occurred', 'tool already dispatched a message')],
      }),
      openai,
    })

    await expect(generate({ params, ctx })).rejects.toMatchObject({ category: 'side_effect_may_have_occurred' })
    expect(openai.calls).toHaveLength(0)
  })
})
