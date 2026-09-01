import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('server-only', () => ({}))

const anthropicCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate }
  },
}))

const { OpenAIAdapter, OpenRouterAdapter } = await import('./providers/openai-compatible')
const { AnthropicAdapter } = await import('./providers/anthropic')

/**
 * Provider-swap equivalence.
 *
 * The contract downstream code depends on is not "the provider returned
 * something" — it is that a structured extraction and a tool call come back
 * in the SAME normalized shape whoever served it. If Anthropic and OpenAI
 * disagreed here, a failover would quietly change what Caye extracted from a
 * customer conversation, which is exactly the class of bug a provider
 * migration is supposed to be incapable of introducing.
 */
const EXTRACTION_TOOL = {
  name: 'record_facts',
  description: 'Record durable business facts.',
  input_schema: {
    type: 'object' as const,
    properties: { facts: { type: 'array', items: { type: 'string' } } },
    required: ['facts'],
  },
}

const REQUEST = {
  model: 'ignored',
  max_tokens: 512,
  system: 'Extract durable facts.',
  messages: [{ role: 'user' as const, content: 'We close at 5pm on Sundays.' }],
  tools: [EXTRACTION_TOOL],
  tool_choice: { type: 'tool' as const, name: 'record_facts' },
}

const EXPECTED_INPUT = { facts: ['Closes at 5pm on Sundays'] }

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  anthropicCreate.mockReset()
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env.OPENAI_API_KEY = 'sk-openai-test'
  process.env.OPENROUTER_API_KEY = 'sk-or-test'
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function openAiToolCallResponse(model: string) {
  return {
    ok: true,
    json: async () => ({
      id: 'chatcmpl-1',
      model,
      choices: [{
        message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'record_facts', arguments: JSON.stringify(EXPECTED_INPUT) } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 120, completion_tokens: 18 },
    }),
    headers: new Headers(),
  }
}

describe('structured extraction is equivalent across providers', () => {
  it('anthropic', async () => {
    anthropicCreate.mockResolvedValue({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'record_facts', input: EXPECTED_INPUT }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 18 },
    })

    const message = await new AnthropicAdapter().generate(REQUEST as never, 'claude-haiku-4-5-20251001')

    expect(message.stop_reason).toBe('tool_use')
    expect(message.content[0]).toMatchObject({ type: 'tool_use', name: 'record_facts', input: EXPECTED_INPUT })
  })

  it('openai', async () => {
    fetchMock.mockResolvedValue(openAiToolCallResponse('gpt-5-mini'))

    const message = await new OpenAIAdapter().generate(REQUEST as never, 'gpt-5-mini')

    expect(message.stop_reason).toBe('tool_use')
    expect(message.content[0]).toMatchObject({ type: 'tool_use', name: 'record_facts', input: EXPECTED_INPUT })
    expect(message.usage.input_tokens).toBe(120)
    expect(message.usage.output_tokens).toBe(18)
  })

  it('openrouter', async () => {
    fetchMock.mockResolvedValue(openAiToolCallResponse('openai/gpt-4.1-mini'))

    const message = await new OpenRouterAdapter().generate(REQUEST as never, 'openai/gpt-4.1-mini')

    expect(message.content[0]).toMatchObject({ type: 'tool_use', name: 'record_facts', input: EXPECTED_INPUT })
  })
})

describe('provider-specific request shaping', () => {
  it('sends a translated tool definition and a forced tool choice to OpenAI', async () => {
    fetchMock.mockResolvedValue(openAiToolCallResponse('gpt-5-mini'))
    await new OpenAIAdapter().generate(REQUEST as never, 'gpt-5-mini')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tools[0].function.name).toBe('record_facts')
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'record_facts' } })
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Extract durable facts.' })
  })

  it('uses max_completion_tokens for GPT-5-class models and max_tokens elsewhere', async () => {
    fetchMock.mockResolvedValue(openAiToolCallResponse('gpt-5-mini'))
    await new OpenAIAdapter().generate(REQUEST as never, 'gpt-5-mini')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_completion_tokens).toBe(512)

    fetchMock.mockResolvedValue(openAiToolCallResponse('openai/gpt-4.1-mini'))
    await new OpenRouterAdapter().generate(REQUEST as never, 'openai/gpt-4.1-mini')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(512)
  })

  it('tells OpenRouter to deny data collection — a fallback must not retain customer data', async () => {
    fetchMock.mockResolvedValue(openAiToolCallResponse('openai/gpt-4.1-mini'))
    await new OpenRouterAdapter().generate(REQUEST as never, 'openai/gpt-4.1-mini')

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).provider).toEqual({ data_collection: 'deny' })
  })

  it('surfaces an HTTP failure as a classified provider error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limit reached',
      headers: new Headers({ 'retry-after': '2' }),
    })

    const adapter = new OpenAIAdapter()
    const error = await adapter.generate(REQUEST as never, 'gpt-5-mini').catch((e) => e)

    expect(error.category).toBe('rate_limit')
    expect(error.opts.retryAfterMs).toBe(2000)
  })

  it('treats a 200 carrying an error envelope as a real failure', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ error: { message: 'Upstream provider returned 503', code: 503 } }),
      headers: new Headers(),
    })

    const error = await new OpenRouterAdapter().generate(REQUEST as never, 'openai/gpt-4.1-mini').catch((e) => e)
    expect(error.category).toBeDefined()
    expect(error.name).toBe('AIProviderError')
  })

  it('reports missing credentials as authentication without a network call', async () => {
    delete process.env.OPENAI_API_KEY
    const error = await new OpenAIAdapter().generate(REQUEST as never, 'gpt-5-mini').catch((e) => e)
    expect(error.category).toBe('authentication')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('credential fingerprinting', () => {
  it('changes when the key changes and never contains the key', () => {
    const adapter = new OpenAIAdapter()
    process.env.OPENAI_API_KEY = 'sk-openai-aaaaaaaaaaaa'
    const first = adapter.credentialFingerprint()
    process.env.OPENAI_API_KEY = 'sk-openai-bbbbbbbbbbbb'
    const second = adapter.credentialFingerprint()

    expect(first).not.toBe(second)
    expect(first).not.toContain('sk-openai')
  })

  it('reports absent when no key is set', () => {
    delete process.env.OPENROUTER_API_KEY
    expect(new OpenRouterAdapter().credentialFingerprint()).toBe('absent')
  })
})
