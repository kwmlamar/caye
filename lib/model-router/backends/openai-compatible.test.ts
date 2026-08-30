import { describe, expect, it } from 'vitest'
import { outputTokenLimit, toOpenAiMessages } from './openai-compatible'

describe('OpenAI-compatible request adapter', () => {
  it('uses max_completion_tokens for native OpenAI reasoning models', () => {
    expect(outputTokenLimit('openai', 8192)).toEqual({ max_completion_tokens: 8192 })
  })

  it('keeps max_tokens for OpenRouter compatibility', () => {
    expect(outputTokenLimit('openrouter', 4096)).toEqual({ max_tokens: 4096 })
  })
})

describe('OpenAI-compatible history adapter', () => {
  it('preserves assistant tool calls and matching tool results', () => {
    const messages = toOpenAiMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.', citations: null },
          { type: 'tool_use', id: 'call_1', name: 'list_active_goals', input: { limit: 3 }, caller: { type: 'direct' } },
        ],
      } as any,
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true}' },
        ],
      } as any,
    ])

    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Checking.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_active_goals' } }],
    })
    expect(messages[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' })
  })
})
