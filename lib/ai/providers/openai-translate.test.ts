import { describe, it, expect, vi } from 'vitest'
vi.mock('server-only', () => ({}))

const { toOpenAiMessages, toOpenAiTools, toOpenAiToolChoice, fromOpenAiResponse, systemText } = await import('./openai-translate')

/**
 * These are the tests that make a provider swap safe. Caye's agent loop
 * re-feeds its own history back to the model every round, so anything that
 * does not survive the round trip — a tool call, a tool result, an image —
 * becomes a silent behaviour change rather than an error.
 */
describe('request translation', () => {
  it('flattens Anthropic system blocks into one system message', () => {
    expect(systemText([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] as never)).toBe('A\n\nB')
    expect(systemText('plain')).toBe('plain')
  })

  it('maps a plain conversation', () => {
    const out = toOpenAiMessages({
      model: 'm',
      max_tokens: 10,
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
    } as never)
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ])
  })

  it('maps assistant tool_use blocks to OpenAI tool_calls', () => {
    const out = toOpenAiMessages({
      model: 'm',
      max_tokens: 10,
      messages: [
        { role: 'assistant', content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup_booking', input: { id: 42 } },
        ] },
      ],
    } as never)
    expect(out[0]).toEqual({
      role: 'assistant',
      content: 'Checking.',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'lookup_booking', arguments: '{"id":42}' } }],
    })
  })

  it('maps tool_result blocks to role:tool messages keyed by call id', () => {
    const out = toOpenAiMessages({
      model: 'm',
      max_tokens: 10,
      messages: [
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'booking found' },
          { type: 'text', text: 'anything else?' },
        ] },
      ],
    } as never)
    expect(out).toEqual([
      { role: 'tool', tool_call_id: 'toolu_1', content: 'booking found' },
      { role: 'user', content: 'anything else?' },
    ])
  })

  it('carries base64 images across as data URLs so vision is not silently dropped', () => {
    const out = toOpenAiMessages({
      model: 'm',
      max_tokens: 10,
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        ] },
      ],
    } as never)
    expect(out[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ])
  })

  it('maps tool definitions and strips Anthropic-only cache_control', () => {
    const tools = toOpenAiTools([
      {
        name: 'send_customer_reply',
        description: 'Send a reply',
        input_schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ] as never)
    expect(tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'send_customer_reply',
          description: 'Send a reply',
          parameters: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
        },
      },
    ])
    expect(JSON.stringify(tools)).not.toContain('cache_control')
  })

  it('maps tool_choice, including the forced-tool-use guarantee front desk relies on', () => {
    expect(toOpenAiToolChoice({ type: 'any' } as never)).toBe('required')
    expect(toOpenAiToolChoice({ type: 'auto' } as never)).toBe('auto')
    expect(toOpenAiToolChoice({ type: 'tool', name: 'classify_intent' } as never)).toEqual({
      type: 'function',
      function: { name: 'classify_intent' },
    })
  })
})

describe('response normalization', () => {
  it('normalizes a text completion into Caye canonical blocks', () => {
    const message = fromOpenAiResponse(
      {
        id: 'chatcmpl-1',
        model: 'gpt-5',
        choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      },
      'gpt-5'
    )
    expect(message.role).toBe('assistant')
    expect(message.content).toEqual([{ type: 'text', text: 'Hi there', citations: null }])
    expect(message.stop_reason).toBe('end_turn')
    expect(message.usage.input_tokens).toBe(100)
    expect(message.usage.output_tokens).toBe(20)
  })

  it('normalizes tool calls back into tool_use blocks the agent loop understands', () => {
    const message = fromOpenAiResponse(
      {
        model: 'gpt-5',
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'call_9', function: { name: 'lookup_booking', arguments: '{"id":42}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: {},
      },
      'gpt-5'
    )
    expect(message.stop_reason).toBe('tool_use')
    expect(message.content).toEqual([{ type: 'tool_use', id: 'call_9', name: 'lookup_booking', input: { id: 42 } }])
  })

  it('never crashes on malformed tool arguments — an empty input beats a thrown turn', () => {
    const message = fromOpenAiResponse(
      { model: 'm', choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'x', arguments: 'not json' } }] } }], usage: {} },
      'm'
    )
    expect((message.content[0] as { input: unknown }).input).toEqual({})
  })

  it('reports cached input tokens separately so cost stays honest', () => {
    const message = fromOpenAiResponse(
      {
        model: 'gpt-5',
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 900 } },
      },
      'gpt-5'
    )
    expect(message.usage.input_tokens).toBe(100)
    expect(message.usage.cache_read_input_tokens).toBe(900)
  })

  it('maps a truncated completion to max_tokens', () => {
    const message = fromOpenAiResponse(
      { model: 'm', choices: [{ message: { content: 'partial' }, finish_reason: 'length' }], usage: {} },
      'm'
    )
    expect(message.stop_reason).toBe('max_tokens')
  })
})

describe('round trip', () => {
  it('survives a full tool round trip: request -> tool_use -> tool_result -> request', () => {
    const assistantTurn = fromOpenAiResponse(
      {
        model: 'gpt-5',
        choices: [{ message: { tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, finish_reason: 'tool_calls' }],
        usage: {},
      },
      'gpt-5'
    )

    const next = toOpenAiMessages({
      model: 'm',
      max_tokens: 10,
      messages: [
        { role: 'user', content: 'find x' },
        { role: 'assistant', content: assistantTurn.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found' }] },
      ],
    } as never)

    expect(next).toEqual([
      { role: 'user', content: 'find x' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'found' },
    ])
  })
})
