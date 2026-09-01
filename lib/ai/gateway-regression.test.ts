import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const healthRows: Record<string, unknown>[] = []
const settingsRows: Record<string, unknown>[] = []

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      return {
        select: async () => ({ data: table === 'ai_provider_health' ? healthRows : settingsRows, error: null }),
        insert: async () => ({ error: null }),
        upsert: async () => ({ error: null }),
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

let restore: (() => void) | null = null
const params = { model: 'ignored', max_tokens: 100, messages: [{ role: 'user' as const, content: 'hi' }] }

function install(providers: { anthropic?: FakeProvider; openai?: FakeProvider; openrouter?: FakeProvider }) {
  restore?.()
  restore = setProviderAdapters({
    anthropic: providers.anthropic ?? new FakeProvider('anthropic'),
    openai: providers.openai ?? new FakeProvider('openai'),
    openrouter: providers.openrouter ?? new FakeProvider('openrouter'),
  })
}

beforeEach(() => {
  restore?.()
  restore = null
  healthRows.length = 0
  settingsRows.length = 0
  resetHealthCache()
  resetProviderSettingsCache()
  vi.unstubAllEnvs()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('gateway failover regressions', () => {
  it('does not call a skipped uncredentialed primary provider a failover', async () => {
    const anthropic = new FakeProvider('anthropic', { hasKey: false })
    install({ anthropic })

    const result = await generate({
      params,
      ctx: { source: 'test', task: 'customer_response' },
    })

    expect(result.routing.provider).toBe('openai')
    expect(result.routing.fellBack).toBe(false)
    expect(anthropic.calls).toHaveLength(0)
  })

  it('quarantines a provider for the rest of the request after billing exhaustion', async () => {
    const anthropic = new FakeProvider('anthropic', {
      behaviour: [httpError(400, 'Your credit balance is too low to access the Anthropic API')],
    })
    const openai = new FakeProvider('openai', { behaviour: [httpError(500, 'temporary upstream failure')] })
    const openrouter = new FakeProvider('openrouter')
    install({ anthropic, openai, openrouter })

    const result = await generate({
      params,
      ctx: { source: 'test', task: 'classification' },
    })

    expect(anthropic.calls).toHaveLength(1)
    expect(result.routing.provider).toBe('openrouter')
    expect(result.routing.fellBack).toBe(true)
    expect(result.routing.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'anthropic', outcome: 'billing_exhausted' }),
      expect.objectContaining({ provider: 'anthropic', outcome: 'skipped_circuit_open' }),
    ]))
  })
})
