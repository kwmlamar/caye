import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { loggedMessagesCreate, providerAdapter } = vi.hoisted(() => ({
  loggedMessagesCreate: vi.fn(),
  providerAdapter: vi.fn(),
}))

vi.mock('@/lib/llm-telemetry', () => ({ loggedMessagesCreate }))
vi.mock('@/lib/ai/providers', () => ({ providerAdapter }))

import { OpenAIApiBackend } from './openai-compatible'
import type { Tool } from '@/lib/caye-agent/tools/types'

const tool: Tool<never> = {
  name: 'test_tool', description: 'Test tool', inputSchema: { type: 'object', properties: {} },
  risk: 'read', roles: ['founder'], modes: ['back-office'], execute: async () => ({ ok: true }),
}

beforeEach(() => {
  providerAdapter.mockReturnValue({ hasCredentials: () => true })
  loggedMessagesCreate.mockReset()
  loggedMessagesCreate.mockResolvedValue({
    content: [{ type: 'text', text: 'done', citations: null }], model: 'gpt-5-mini', usage: { input_tokens: 10, output_tokens: 2 },
  })
})

describe('OpenAI-compatible Caye Direct backend', () => {
  it('delegates a tool turn to the canonical gateway in Caye canonical format', async () => {
    const backend = new OpenAIApiBackend()
    await backend.invokeTurn({
      ctx: { founderUserId: 'founder', threadId: 'thread', workspaceId: 'workspace' },
      system: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [tool], maxOutputTokens: 128,
    }, new AbortController().signal)

    expect(loggedMessagesCreate).toHaveBeenCalledWith(null, expect.objectContaining({
      system: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [expect.objectContaining({ name: 'test_tool' })],
    }), expect.objectContaining({ pinProvider: 'openai', task: 'agent_planning', workspaceId: 'workspace' }), expect.anything())
  })

  it('uses gateway-owned credentials for health checks', async () => {
    const backend = new OpenAIApiBackend()
    await expect(backend.checkHealth()).resolves.toMatchObject({ state: 'available' })
    expect(providerAdapter).toHaveBeenCalledWith('openai')
  })
})
