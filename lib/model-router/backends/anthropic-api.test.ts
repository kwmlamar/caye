import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { loggedMessagesCreate } = vi.hoisted(() => ({
  loggedMessagesCreate: vi.fn(),
}))

vi.mock('@/lib/llm-telemetry', () => ({ loggedMessagesCreate }))

import { AnthropicApiBackend } from './anthropic-api'
import type { Tool } from '@/lib/caye-agent/tools/types'

const tool: Tool<never> = {
  name: 'test_tool',
  description: 'Test tool',
  inputSchema: { type: 'object', properties: {} },
  risk: 'read',
  roles: ['founder'],
  modes: ['back-office'],
  execute: async () => ({ ok: true }),
}

beforeEach(() => {
  loggedMessagesCreate.mockReset()
  loggedMessagesCreate.mockResolvedValue({
    content: [{ type: 'text', text: 'done', citations: null }],
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 10, output_tokens: 2 },
  })
})

describe('AnthropicApiBackend Caye Direct prompt caching', () => {
  it('keeps stable tools at 1h while caching the dynamic system prompt for 5m', async () => {
    const backend = new AnthropicApiBackend()

    await backend.invokeTurn(
      {
        ctx: { founderUserId: 'founder', threadId: 'thread', workspaceId: 'workspace' },
        system: 'dynamic thread and operational context',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [tool],
        maxOutputTokens: 128,
      },
      new AbortController().signal
    )

    expect(loggedMessagesCreate).toHaveBeenCalledTimes(1)
    const params = loggedMessagesCreate.mock.calls[0][1]
    expect(params.system).toEqual([
      {
        type: 'text',
        text: 'dynamic thread and operational context',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
    ])
    expect(params.tools).toHaveLength(1)
    expect(params.tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })
})
