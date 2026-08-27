import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { loggedMessagesCreate } = vi.hoisted(() => ({ loggedMessagesCreate: vi.fn() }))
vi.mock('@/lib/llm-telemetry', () => ({ loggedMessagesCreate }))

vi.mock('./tools/registry', () => ({ TOOL_REGISTRY: [] }))

import { runToolLoop } from './execute'

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    model: 'claude-sonnet-4-6',
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }
}

describe('runToolLoop request-level LLM telemetry', () => {
  it('passes stable request/role metadata and a 1-based loop iteration', async () => {
    loggedMessagesCreate.mockReset()
    loggedMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tool-1', name: 'missing_tool', input: {} }],
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10, output_tokens: 2 },
    })
    loggedMessagesCreate.mockResolvedValueOnce(textResponse('done'))

    const result = await runToolLoop({
      client: {} as never,
      model: 'claude-sonnet-4-6',
      maxTokens: 128,
      systemPrompt: 'test',
      initialMessages: [{ role: 'user', content: 'test' }],
      tools: [],
      ctx: {
        workspaceId: 'ws-test',
        callerRole: 'owner',
        operatorId: 1,
        requestId: 'req-stable-123',
      },
    })

    expect(result.replyText).toBe('done')
    expect(loggedMessagesCreate).toHaveBeenCalledTimes(2)
    expect(loggedMessagesCreate.mock.calls[0][2]).toEqual({
      source: 'lib/caye-agent/execute.ts:runToolLoop',
      workspaceId: 'ws-test',
      requestId: 'req-stable-123',
      callerRole: 'owner',
      loopIteration: 1,
    })
    expect(loggedMessagesCreate.mock.calls[1][2]).toEqual({
      source: 'lib/caye-agent/execute.ts:runToolLoop',
      workspaceId: 'ws-test',
      requestId: 'req-stable-123',
      callerRole: 'owner',
      loopIteration: 2,
    })
  })
})
