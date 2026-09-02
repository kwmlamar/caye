import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { OpenAIAdapter, OpenRouterAdapter } from './openai-compatible'

afterEach(() => vi.unstubAllGlobals())

const params = { model: 'ignored', max_tokens: 1000, messages: [{ role: 'user' as const, content: 'hello' }] } as any
const success = () => new Response(JSON.stringify({ model: 'served', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }), { status: 200 })

describe('canonical OpenAI-compatible adapter semantics', () => {
  it('uses GPT-5 completion-token and minimal-reasoning controls for a short turn', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    const fetch = vi.fn(success)
    vi.stubGlobal('fetch', fetch)

    await new OpenAIAdapter().generate(params, 'gpt-5-mini')

    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ max_completion_tokens: 1000, reasoning_effort: 'minimal' })
  })

  it('keeps OpenRouter data collection disabled and uses its max_tokens contract', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    const fetch = vi.fn(success)
    vi.stubGlobal('fetch', fetch)

    await new OpenRouterAdapter().generate(params, 'openai/gpt-4.1-mini')

    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ max_tokens: 1000, provider: { data_collection: 'deny' } })
  })
})
