import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

function install(providers: { anthropic?: FakeProvider; openai?: FakeProvider; openrouter?: FakeProvider }) {
  restore?.()
  restore = setProviderAdapters({
    anthropic: providers.anthropic ?? new FakeProvider('anthropic'),
    openai: providers.openai ?? new FakeProvider('openai'),
    openrouter: providers.openrouter ?? new FakeProvider('openrouter'),
  })
}

beforeEach(() => {
  healthRows.length = 0
  settingsRows.length = 0
  resetHealthCache()
  resetProviderSettingsCache()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  restore?.()
  restore = null
  vi.restoreAllMocks()
})

describe('provider-portable tool surfaces', () => {
  it('serves the live-observed 129-tool founder shape through OpenAI after Anthropic fails', async () => {
    const anthropic = new FakeProvider('anthropic', {
      behaviour: [httpError(503, 'anthropic unavailable')],
    })
    const openai = new FakeProvider('openai')
    install({ anthropic, openai })

    const tools = Array.from({ length: 129 }, (_, i) => ({
      name: `tool_${i}`,
      description: i === 128 ? 'Find unresolved customer issues and business attention items' : `Generic tool ${i}`,
      input_schema: { type: 'object' as const, properties: {} },
    }))

    const result = await generate({
      params: {
        model: 'ignored',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: 'Tell me whether there are unresolved customer issues that need my attention.',
          },
        ],
        tools,
      },
      ctx: {
        source: 'lib/caye-agent/execute.ts:runToolLoop',
        task: 'agent_planning',
        workspaceId: 'ws-founder',
        callerRole: 'founder',
        loopIteration: 1,
      },
    })

    expect(result.routing.provider).toBe('openai')
    expect(result.routing.attempts.map((attempt) => attempt.outcome)).toEqual(['upstream_5xx', 'success'])
    expect(openai.calls).toHaveLength(1)
    expect(openai.calls[0].params.tools).toHaveLength(128)
    expect(openai.calls[0].params.tools?.map((tool) => tool.name)).toContain('tool_128')
    expect(result.routing.attempts[1].detail).toContain('adapted tool surface 129->128')
  })

  it('does not mutate the canonical request while adapting a provider attempt', async () => {
    const anthropic = new FakeProvider('anthropic', {
      behaviour: [httpError(503, 'anthropic unavailable')],
    })
    const openai = new FakeProvider('openai', {
      behaviour: [httpError(503, 'openai unavailable')],
    })
    const openrouter = new FakeProvider('openrouter')
    install({ anthropic, openai, openrouter })

    const tools = Array.from({ length: 129 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}`,
      input_schema: { type: 'object' as const, properties: {} },
    }))
    const request = {
      model: 'ignored',
      max_tokens: 100,
      messages: [{ role: 'user' as const, content: 'help' }],
      tools,
    }

    const result = await generate({
      params: request,
      ctx: { source: 'test', task: 'agent_planning' },
    })

    expect(result.routing.provider).toBe('openrouter')
    expect(request.tools).toHaveLength(129)
    expect(openai.calls[0].params.tools).toHaveLength(128)
    expect(openrouter.calls[0].params.tools).toHaveLength(129)
  })
})
