import { describe, it, expect, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

// Neutralize the 'server-only' guard so vitest (node env) can load the
// agent modules. Vitest doesn't ship a server boundary.
vi.mock('server-only', () => ({}))

import { runToolLoop } from './execute'
import type { Tool, ToolContext } from './tools/types'

// Vitest mocks the registry so we can inject a single, owner-only tool
// and assert that a 'staff'-role caller is rejected with a structured
// tool_result error. The model loop runs once: it asks for the tool,
// the gate blocks it, the loop sends the rejection back, the model
// returns text, we're done.
vi.mock('./tools/registry', async () => {
  const ownerOnlyTool: Tool<{ note: string }> = {
    name: 'owner_only_tool',
    description: 'A tool only the owner can call.',
    risk: 'low',
    roles: ['owner', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: ['note'],
    },
    async execute() {
      return { ok: true, data: { ran: true } }
    },
  }
  return {
    TOOL_REGISTRY: [ownerOnlyTool],
    findTool: (name: string) =>
      name === 'owner_only_tool' ? ownerOnlyTool : undefined,
  }
})

// Mock the telemetry wrapper so we don't write to supabase from a test.
vi.mock('@/lib/llm-telemetry', () => ({
  loggedMessagesCreate: async (
    _client: unknown,
    params: { messages: Anthropic.MessageParam[] }
  ) => {
    const callNumber = params.messages.filter((m) => m.role === 'assistant').length
    if (callNumber === 0) {
      // First model turn: ask to call the tool.
      return {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'tool_use',
        stop_sequence: null,
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'owner_only_tool',
            input: { note: 'hi' },
          },
        ],
      }
    }
    // Second model turn: produce a text reply after seeing the gate error.
    return {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [{ type: 'text', text: 'sorry, can\'t do that for staff' }],
    }
  },
}))

describe('runToolLoop role enforcement (#48)', () => {
  it("rejects a 'staff' caller from an owner+founder-only tool", async () => {
    const ctx: ToolContext = {
      workspaceId: 'ws_test',
      callerRole: 'staff',
      requestId: 'req_test_staff',
    }

    const result = await runToolLoop({
      client: {} as Anthropic,
      model: 'claude-sonnet-4-6',
      maxTokens: 256,
      systemPrompt: 'You are a test agent.',
      initialMessages: [{ role: 'user', content: 'call the tool' }],
      ctx,
    })

    // The user turn carrying tool_results should contain a structured
    // error rejecting the staff caller — surfaced through the
    // tool_result, NOT thrown.
    const toolResultTurn = result.newTurns.find(
      (t) =>
        t.role === 'user' &&
        Array.isArray(t.content) &&
        t.content.some(
          (b) => typeof b === 'object' && (b as { type?: string }).type === 'tool_result'
        )
    )
    expect(toolResultTurn).toBeDefined()
    const block = (toolResultTurn!.content as unknown[]).find(
      (b) => (b as { type?: string }).type === 'tool_result'
    ) as { content: string; is_error?: boolean }
    expect(block.is_error).toBe(true)
    const payload = JSON.parse(block.content)
    expect(payload.ok).toBe(false)
    expect(payload.error).toMatch(/staff/)
    expect(payload.error).toMatch(/owner/)
  })

  it("permits an 'owner' caller through the same tool", async () => {
    const ctx: ToolContext = {
      workspaceId: 'ws_test',
      callerRole: 'owner',
      requestId: 'req_test_owner',
    }
    const result = await runToolLoop({
      client: {} as Anthropic,
      model: 'claude-sonnet-4-6',
      maxTokens: 256,
      systemPrompt: 'You are a test agent.',
      initialMessages: [{ role: 'user', content: 'call the tool' }],
      ctx,
    })

    const toolResultTurn = result.newTurns.find(
      (t) =>
        t.role === 'user' &&
        Array.isArray(t.content) &&
        t.content.some(
          (b) => typeof b === 'object' && (b as { type?: string }).type === 'tool_result'
        )
    )
    const block = (toolResultTurn!.content as unknown[]).find(
      (b) => (b as { type?: string }).type === 'tool_result'
    ) as { content: string; is_error?: boolean }
    expect(block.is_error).toBe(false)
    const payload = JSON.parse(block.content)
    expect(payload.ok).toBe(true)
  })
})
