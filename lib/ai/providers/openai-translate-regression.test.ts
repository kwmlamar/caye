import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { toOpenAiMessages } = await import('./openai-translate')

describe('OpenAI fallback translation regressions', () => {
  it('preserves images nested inside tool results', () => {
    const messages = toOpenAiMessages({
      model: 'ignored',
      max_tokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'inspect', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: [
                { type: 'text', text: 'inspection result' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
                },
              ],
            },
          ],
        },
      ],
    })

    expect(messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'tool_1' })
    expect(messages[1].content).not.toContain('image omitted')
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,aGVsbG8=' },
        },
      ],
    })
  })
})
