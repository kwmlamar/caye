import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

// Neutralize the 'server-only' guard so vitest (node env) can load the
// agent modules. Vitest doesn't ship a server boundary.
vi.mock('server-only', () => ({}))

// The output-safety fallback (Phase 3B / final pre-canary closure) reads
// business facts and the conversation thread for its payment/logistics
// checks — mock both so tests don't need real Supabase credentials.
// Mutable via vi.hoisted() so individual tests can set grounding content
// before calling, without needing vi.doMock/vi.resetModules churn.
const mockState = vi.hoisted(() => ({
  businessFacts: [] as Array<{ id: string; category: string; fact: string }>,
  threadRows: [] as Array<{ content: string }>,
}))
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => {
        // Chainable .eq() any number of times — the plain thread fetch
        // uses two (conversation_id, is_internal), the business-only
        // fetch (payment grounding) adds a third (sender_type).
        const builder: { eq: () => typeof builder; order: () => unknown } = {
          eq: () => builder,
          order: () => ({
            limit: () => Promise.resolve({ data: mockState.threadRows, error: null }),
          }),
        }
        return builder
      },
    }),
  }),
}))
vi.mock('@/lib/business-facts', () => ({
  fetchBusinessFacts: async () => mockState.businessFacts,
}))

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

describe('runToolLoop tool_choice (Phase 3B — structural front-desk output safety)', () => {
  it('forces tool_choice: any on front-desk mode, matching production caye-reply.ts', async () => {
    const seenToolChoices: unknown[] = []
    vi.doMock('@/lib/llm-telemetry', () => ({
      loggedMessagesCreate: async (_client: unknown, params: { tool_choice?: unknown }) => {
        seenToolChoices.push(params.tool_choice)
        return {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: 'ok' }],
        }
      },
    }))
    vi.resetModules()
    const { runToolLoop: freshRunToolLoop } = await import('./execute')

    const ctx: ToolContext = { workspaceId: 'ws_test', callerRole: 'owner', requestId: 'req_fd' }
    await freshRunToolLoop({
      client: {} as Anthropic,
      model: 'claude-sonnet-4-6',
      maxTokens: 256,
      systemPrompt: 'front desk agent',
      initialMessages: [{ role: 'user', content: 'hi' }],
      ctx,
      mode: 'front-desk',
      tools: [
        {
          name: 'send_customer_reply',
          description: 'test',
          risk: 'high',
          roles: ['owner'],
          modes: ['front-desk'],
          inputSchema: { type: 'object', properties: {} },
          async execute() {
            return { ok: true }
          },
        } as unknown as Tool<never>,
      ],
    })

    expect(seenToolChoices[0]).toEqual({ type: 'any' })
    vi.doUnmock('@/lib/llm-telemetry')
  })

  it('does not force tool_choice on back-office mode', async () => {
    const seenToolChoices: unknown[] = []
    vi.doMock('@/lib/llm-telemetry', () => ({
      loggedMessagesCreate: async (_client: unknown, params: { tool_choice?: unknown }) => {
        seenToolChoices.push(params.tool_choice)
        return {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: 'ok' }],
        }
      },
    }))
    vi.resetModules()
    const { runToolLoop: freshRunToolLoop } = await import('./execute')

    const ctx: ToolContext = { workspaceId: 'ws_test', callerRole: 'owner', requestId: 'req_bo' }
    await freshRunToolLoop({
      client: {} as Anthropic,
      model: 'claude-sonnet-4-6',
      maxTokens: 256,
      systemPrompt: 'back office agent',
      initialMessages: [{ role: 'user', content: 'hi' }],
      ctx,
      tools: [],
    })

    expect(seenToolChoices[0]).toBeUndefined()
    vi.doUnmock('@/lib/llm-telemetry')
  })

  it('does not force tool_choice on front-desk mode when zero tools are offered (would be an invalid API call)', async () => {
    const seenToolChoices: unknown[] = []
    vi.doMock('@/lib/llm-telemetry', () => ({
      loggedMessagesCreate: async (_client: unknown, params: { tool_choice?: unknown }) => {
        seenToolChoices.push(params.tool_choice)
        return {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: 'ok' }],
        }
      },
    }))
    vi.resetModules()
    const { runToolLoop: freshRunToolLoop } = await import('./execute')

    const ctx: ToolContext = { workspaceId: 'ws_test', callerRole: 'owner', requestId: 'req_fd_empty' }
    await freshRunToolLoop({
      client: {} as Anthropic,
      model: 'claude-sonnet-4-6',
      maxTokens: 256,
      systemPrompt: 'front desk agent',
      initialMessages: [{ role: 'user', content: 'hi' }],
      ctx,
      mode: 'front-desk',
      tools: [],
    })

    expect(seenToolChoices[0]).toBeUndefined()
    vi.doUnmock('@/lib/llm-telemetry')
  })
})

describe('runToolLoop terminatesTurn (Phase 3B — stops the loop after a successful terminal tool)', () => {
  it('returns immediately with delivered_text after a terminatesTurn tool succeeds, without a second model round', async () => {
    let modelCallCount = 0
    vi.doMock('@/lib/llm-telemetry', () => ({
      loggedMessagesCreate: async () => {
        modelCallCount++
        return {
          id: `msg_${modelCallCount}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: 'tool_use',
          stop_sequence: null,
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'send_customer_reply', input: { conversation_id: 'c1', body: 'All set!' } },
          ],
        }
      },
    }))
    vi.resetModules()
    const { runToolLoop: freshRunToolLoop } = await import('./execute')

    const terminalTool: Tool<never> = {
      name: 'send_customer_reply',
      description: 'test',
      risk: 'high',
      roles: ['owner'],
      modes: ['front-desk'],
      terminatesTurn: true,
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return { ok: true, data: { delivered_text: 'All set!' } }
      },
    }

    const ctx: ToolContext = { workspaceId: 'ws_test', callerRole: 'owner', requestId: 'req_terminal' }
    const result = await freshRunToolLoop({
      client: {} as Anthropic,
      model: 'claude-sonnet-4-6',
      maxTokens: 256,
      systemPrompt: 'front desk agent',
      initialMessages: [{ role: 'user', content: 'thanks!' }],
      ctx,
      mode: 'front-desk',
      tools: [terminalTool],
    })

    expect(result.replyText).toBe('All set!')
    expect(result.usedOutputFallbackPath).toBeUndefined()
    // Exactly one model call: the loop must NOT go back for a second round
    // after the terminal tool succeeded, even with tool_choice: 'any' set.
    expect(modelCallCount).toBe(1)
    vi.doUnmock('@/lib/llm-telemetry')
  })

  it('does NOT terminate when the terminatesTurn tool call failed (held) — loop continues', async () => {
    let modelCallCount = 0
    vi.doMock('@/lib/llm-telemetry', () => ({
      loggedMessagesCreate: async () => {
        modelCallCount++
        if (modelCallCount === 1) {
          return {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 0, output_tokens: 0 },
            stop_reason: 'tool_use',
            stop_sequence: null,
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'send_customer_reply', input: { conversation_id: 'c1', body: '$999' } },
            ],
          }
        }
        return {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: 'tool_use',
          stop_sequence: null,
          content: [
            { type: 'tool_use', id: 'toolu_2', name: 'send_customer_reply', input: { conversation_id: 'c1', body: 'grounded reply' } },
          ],
        }
      },
    }))
    vi.resetModules()
    const { runToolLoop: freshRunToolLoop } = await import('./execute')

    let callCount = 0
    const flakyTerminalTool: Tool<never> = {
      name: 'send_customer_reply',
      description: 'test',
      risk: 'high',
      roles: ['owner'],
      modes: ['front-desk'],
      terminatesTurn: true,
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        callCount++
        if (callCount === 1) return { ok: false, status: 'NEEDS_HUMAN', error: 'held' }
        return { ok: true, data: { delivered_text: 'grounded reply' } }
      },
    }

    const ctx: ToolContext = { workspaceId: 'ws_test', callerRole: 'owner', requestId: 'req_terminal_2' }
    const result = await freshRunToolLoop({
      client: {} as Anthropic,
      model: 'claude-sonnet-4-6',
      maxTokens: 256,
      systemPrompt: 'front desk agent',
      initialMessages: [{ role: 'user', content: 'how much?' }],
      ctx,
      mode: 'front-desk',
      tools: [flakyTerminalTool],
    })

    expect(modelCallCount).toBe(2)
    expect(result.replyText).toBe('grounded reply')
    vi.doUnmock('@/lib/llm-telemetry')
  })
})

describe('runToolLoop defense-in-depth on front-desk (Phase 3B — Part B adversarial cases)', () => {
  /**
   * Simulates the anomaly `tool_choice: { type: 'any' }` is meant to
   * prevent: the model returns text with ZERO tool_use blocks. Tests
   * whether execute.ts's fallback evidence check catches an unsupported
   * claim anyway, independent of whether the model ever called
   * send_customer_reply.
   */
  beforeEach(() => {
    mockState.businessFacts = []
    mockState.threadRows = []
  })

  async function runAnomalousTextTurn(replyText: string, evidenceCollected: string[], conversationId?: string) {
    vi.doMock('@/lib/llm-telemetry', () => ({
      loggedMessagesCreate: async () => ({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
        stop_sequence: null,
        content: [{ type: 'text', text: replyText }],
      }),
    }))
    vi.resetModules()
    const { runToolLoop: freshRunToolLoop } = await import('./execute')
    const ctx: ToolContext = {
      workspaceId: 'ws_test',
      callerRole: 'owner',
      requestId: 'req_adversarial',
      evidenceCollected: evidenceCollected as never[],
      conversationId,
    }
    const result = await freshRunToolLoop({
      client: {} as Anthropic,
      model: 'claude-sonnet-4-6',
      maxTokens: 256,
      systemPrompt: 'front desk agent',
      initialMessages: [{ role: 'user', content: 'how much is it?' }],
      ctx,
      mode: 'front-desk',
      tools: [
        {
          name: 'send_customer_reply',
          description: 'test',
          risk: 'high',
          roles: ['owner'],
          modes: ['front-desk'],
          inputSchema: { type: 'object', properties: {} },
          async execute() {
            return { ok: true }
          },
        } as unknown as Tool<never>,
      ],
    })
    vi.doUnmock('@/lib/llm-telemetry')
    return result
  }

  it('blocks an unsupported price claim that reaches the loop as plain text with no evidence', async () => {
    const result = await runAnomalousTextTurn('That will be $450 total for the two of you.', [])
    expect(result.replyText).not.toContain('$450')
    expect(result.usedOutputFallbackPath).toBe(true)
  })

  it('allows a price claim through once price_from_database evidence was actually collected', async () => {
    const result = await runAnomalousTextTurn('That will be $450 total for the two of you.', [
      'service_identified',
      'price_from_database',
    ])
    expect(result.replyText).toContain('$450')
  })

  it('blocks an unsupported availability claim with no evidence', async () => {
    const result = await runAnomalousTextTurn('That date is available for you.', [])
    expect(result.replyText).not.toContain('That date is available')
  })

  it('allows an availability claim through once availability_verified evidence was actually collected', async () => {
    const result = await runAnomalousTextTurn('That date is available for you.', [
      'service_identified',
      'date_identified',
      'availability_verified',
    ])
    expect(result.replyText).toContain('That date is available')
  })

  it('passes a safe, claim-free reply through untouched even with zero evidence, but still flags the fallback path', async () => {
    const result = await runAnomalousTextTurn(
      "You're so welcome — see you then! Let me know if anything else comes up.",
      []
    )
    expect(result.replyText).toBe("You're so welcome — see you then! Let me know if anything else comes up.")
    expect(result.usedOutputFallbackPath).toBe(true)
  })

  // ── Final pre-canary closure: identity, payment figure, payment method, logistics ──

  it('blocks a plain-text reply that leaks Caye identity even with sufficient evidence', async () => {
    const result = await runAnomalousTextTurn('All set! Best, Caye', ['service_identified', 'price_from_database'])
    expect(result.replyText).not.toContain('Best, Caye')
    expect(result.usedOutputFallbackPath).toBe(true)
  })

  it('blocks a plain-text unverified payment-figure claim', async () => {
    const result = await runAnomalousTextTurn('A 25% deposit ($99.50) is required to hold the date.', [])
    expect(result.replyText).not.toContain('25%')
  })

  it('allows a plain-text payment-figure claim once business facts attest it', async () => {
    mockState.businessFacts = [{ id: 'f1', category: 'policy', fact: 'A 25% deposit is required at booking.' }]
    const result = await runAnomalousTextTurn('A 25% deposit ($99.50) is required to hold the date.', [
      'service_identified',
      'price_from_database',
    ])
    expect(result.replyText).toContain('25%')
    expect(result.usedOutputFallbackPath).toBe(true)
  })

  it('blocks a plain-text unverified payment-method claim (real Bimini cash-acceptance incident)', async () => {
    const result = await runAnomalousTextTurn('Unfortunately, cash is not accepted for this tour.', [])
    expect(result.replyText).not.toContain('cash')
  })

  it('allows a plain-text payment-method claim once business facts document it', async () => {
    mockState.businessFacts = [{ id: 'f1', category: 'policy', fact: 'We accept cash or card on the day of the tour.' }]
    const result = await runAnomalousTextTurn('Cash is accepted on the day of your tour.', [])
    expect(result.replyText).toContain('Cash is accepted')
  })

  it('blocks a plain-text ungrounded logistics-time claim when conversationId is known', async () => {
    mockState.threadRows = [{ content: 'Customer: what time should we arrive at the dock?' }]
    const result = await runAnomalousTextTurn(
      'The ferry arrives at 11am, so please be at the dock by 10:30.',
      ['service_identified', 'price_from_database'],
      'conv_known'
    )
    expect(result.replyText).not.toContain('11am')
  })

  it('allows a grounded logistics-time claim when conversationId is known and the thread supports it', async () => {
    mockState.threadRows = [{ content: 'Operator: the ferry arrives at 11am, plan to be there by 10:30.' }]
    const result = await runAnomalousTextTurn(
      'Just a reminder — the ferry arrives at 11am, so please be at the dock by 10:30.',
      [],
      'conv_known'
    )
    expect(result.replyText).toContain('11am')
  })

  it('skips the logistics check (does not crash) when conversationId is not set', async () => {
    const result = await runAnomalousTextTurn('The ferry arrives at 11am.', [])
    // No conversationId means no thread to check against — this path is a
    // documented, disclosed gap (see ToolContext.conversationId), not a
    // crash or a silent block on unrelated grounds.
    expect(result.replyText).toBe('The ferry arrives at 11am.')
  })
})

describe('runToolLoop action-grounding on back-office (2026-08-16 Mrs. Max incident)', () => {
  const sendTool = (execute: () => Promise<{ ok: boolean; data?: unknown; error?: string }>): Tool<never> =>
    ({
      name: 'send_reply',
      description: 'test',
      risk: 'high',
      roles: ['owner', 'founder'],
      modes: ['back-office'],
      inputSchema: { type: 'object', properties: {} },
      execute,
    }) as unknown as Tool<never>

  const reminderTool = (execute: () => Promise<{ ok: boolean; data?: unknown; error?: string }>): Tool<never> =>
    ({
      name: 'schedule_reminder',
      description: 'test',
      risk: 'low',
      roles: ['owner', 'founder'],
      modes: ['back-office'],
      inputSchema: { type: 'object', properties: {} },
      execute,
    }) as unknown as Tool<never>

  async function runBackOfficeTurns(
    turns: Anthropic.Message[],
    tools: Tool<never>[]
  ) {
    let call = 0
    vi.doMock('@/lib/llm-telemetry', () => ({
      loggedMessagesCreate: async () => turns[Math.min(call++, turns.length - 1)],
    }))
    vi.resetModules()
    const { runToolLoop: freshRunToolLoop } = await import('./execute')
    const ctx: ToolContext = { workspaceId: 'ws_test', callerRole: 'founder', requestId: 'req_grounding' }
    const result = await freshRunToolLoop({
      client: {} as Anthropic,
      model: 'claude-sonnet-4-6',
      maxTokens: 256,
      systemPrompt: 'back office agent',
      initialMessages: [{ role: 'user', content: 'message Mrs. Max about this' }],
      ctx,
      tools,
    })
    vi.doUnmock('@/lib/llm-telemetry')
    return result
  }

  const textTurn = (text: string): Anthropic.Message =>
    ({
      id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text }],
    }) as Anthropic.Message

  const toolUseTurn = (name: string, input: Record<string, unknown> = {}): Anthropic.Message =>
    ({
      id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'tool_use', stop_sequence: null,
      content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
    }) as Anthropic.Message

  // 1. Model wants to send but no tool executes — Caye cannot say "sent".
  it('strips a "sent" claim backed by zero tool calls (the real incident: fabricated completion)', async () => {
    const result = await runBackOfficeTurns(
      [textTurn("Here's what I sent her on WhatsApp just now: hi Mrs. Max, quick question.")],
      [sendTool(async () => ({ ok: true }))]
    )
    expect(result.replyText).not.toContain("Here's what I sent her on WhatsApp just now")
    expect(result.replyText).toContain('I have not actually sent anything')
    // Critical: the PERSISTED turn (what caye_operator_messages stores and
    // what Caye Direct/Live renders on reload) must also carry the
    // correction, not the raw hallucinated claim — see execute.ts's turn
    // patch right after applyActionGrounding.
    const lastAssistantTurn = result.newTurns[result.newTurns.length - 1]
    expect(lastAssistantTurn.role).toBe('assistant')
    const textBlock = (lastAssistantTurn.content as Array<{ type: string; text?: string }>).find(
      (b) => b.type === 'text'
    )
    expect(textBlock?.text).not.toContain("Here's what I sent her on WhatsApp just now")
    expect(textBlock?.text).toContain('I have not actually sent anything')
  })

  // 2. Send tool fails — Caye must not claim it went out anyway.
  it('strips a "sent" claim when the send tool was actually called but failed', async () => {
    const result = await runBackOfficeTurns(
      [
        toolUseTurn('send_reply', { conversation_id: 'c1', body: 'hi' }),
        textTurn("Sent! I've messaged her the update."),
      ],
      [sendTool(async () => ({ ok: false, error: 'WhatsApp window closed' }))]
    )
    expect(result.replyText).not.toContain("I've messaged her")
  })

  // 3. Send tool succeeds — Caye may say "sent".
  it('lets a "sent" claim through when the send tool actually succeeded', async () => {
    const result = await runBackOfficeTurns(
      [
        toolUseTurn('send_reply', { conversation_id: 'c1', body: 'hi' }),
        textTurn('I sent that reply to her just now.'),
      ],
      [sendTool(async () => ({ ok: true, data: { sent: true, message_id: 'wamid.abc' } }))]
    )
    expect(result.replyText).toBe('I sent that reply to her just now.')
  })

  // 4. Send requires approval — Caye must say awaiting approval, not sent.
  it('strips a "sent" claim when the send only staged a pending confirmation', async () => {
    const result = await runBackOfficeTurns(
      [
        toolUseTurn('send_reply', { conversation_id: 'c1', body: 'hi' }),
        textTurn('I sent that reply to her.'),
      ],
      [
        sendTool(async () => ({
          ok: true,
          data: { pending: true, executed: false, status: 'awaiting_operator_confirmation' },
        })),
      ]
    )
    expect(result.replyText).not.toContain('I sent that reply')
  })

  // 5. Scheduled job creation fails — Caye cannot say "I've set a reminder".
  it('strips a "set a reminder" claim when schedule_reminder failed', async () => {
    const result = await runBackOfficeTurns(
      [
        toolUseTurn('schedule_reminder', { date: '2026-08-16', time: '14:00', message: 'follow up' }),
        textTurn("I've set a reminder for 2pm today."),
      ],
      [reminderTool(async () => ({ ok: false, error: 'notifications paused' }))]
    )
    expect(result.replyText).not.toContain("I've set a reminder")
  })

  // 6. Scheduled job creation succeeds — Caye may report the actual scheduled time.
  it('lets a "set a reminder" claim through when schedule_reminder actually succeeded', async () => {
    const result = await runBackOfficeTurns(
      [
        toolUseTurn('schedule_reminder', { date: '2026-08-16', time: '14:00', message: 'follow up' }),
        textTurn("I've set a reminder for 2pm today."),
      ],
      [reminderTool(async () => ({ ok: true, data: { reminder_id: 'r1', fires_at_local: '2:00 PM' } }))]
    )
    expect(result.replyText).toBe("I've set a reminder for 2pm today.")
  })

  // 2026-08-16 stale-claim regression: three hours after the original
  // incident, asked again, the model produced this EXACT sentence with
  // ZERO tool calls in the turn — inherited from poisoned history rather
  // than fabricated fresh, but the live guard must catch it either way,
  // as a second, independent layer behind the historical-context fix in
  // context.ts/history-grounding.ts (which stops the poisoned row from
  // ever reaching the model's context in the first place).
  it('strips "I already sent... 3 hours ago" even with zero tool calls this turn (2026-08-16 regression, real wording)', async () => {
    const result = await runBackOfficeTurns(
      [
        textTurn(
          "I already sent her that message 3 hours ago — it covers all four decisions (Kenneth's rate, Karin's payment method, Charissa's rate confirmation, Rayna's pricing). Still waiting on her reply.\n\nWant me to send a nudge, or leave it until the 2pm reminder fires?"
        ),
      ],
      [sendTool(async () => ({ ok: true }))]
    )
    expect(result.replyText).not.toContain('I already sent her')
    expect(result.replyText).toContain('I have not actually sent anything')
    // The rest of the (non-claim) message survives.
    expect(result.replyText).toContain('Want me to send a nudge')
  })

  // Invariant: a fabricated historical claim must not prevent Caye from
  // performing the REAL send when subsequently instructed — the guard only
  // ever corrects PROSE, it never blocks or short-circuits a genuine tool
  // call in the same or a later turn.
  it('a fabricated historical claim does not prevent a real send when instructed again', async () => {
    const result = await runBackOfficeTurns(
      [
        toolUseTurn('send_reply', { conversation_id: 'c1', body: 'the four decisions' }),
        textTurn('Sent — she should have it now.'),
      ],
      [sendTool(async () => ({ ok: true, data: { sent: true, message_id: 'wamid.real' } }))]
    )
    expect(result.replyText).toBe('Sent — she should have it now.')
  })
})

describe('runToolLoop — internal tool names never reach the operator (2026-08-17 Pam Ott incident)', () => {
  const textTurn = (text: string): Anthropic.Message =>
    ({
      id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text }],
    }) as Anthropic.Message

  async function runBackOfficeTurn(text: string, tools: Tool<never>[]) {
    vi.doMock('@/lib/llm-telemetry', () => ({
      loggedMessagesCreate: async () => textTurn(text),
    }))
    vi.resetModules()
    const { runToolLoop: freshRunToolLoop } = await import('./execute')
    const ctx: ToolContext = { workspaceId: 'ws_test', callerRole: 'owner', requestId: 'req_leak' }
    const result = await freshRunToolLoop({
      client: {} as Anthropic,
      model: 'claude-sonnet-4-6',
      maxTokens: 256,
      systemPrompt: 'back office agent',
      initialMessages: [{ role: 'user', content: 'draft please' }],
      ctx,
      tools,
    })
    vi.doUnmock('@/lib/llm-telemetry')
    return result
  }

  const dummyTool = (name: string): Tool<never> =>
    ({
      name,
      description: 'test',
      risk: 'high',
      roles: ['owner', 'founder'],
      modes: ['back-office'],
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return { ok: true }
      },
    }) as unknown as Tool<never>

  // The real, verbatim leaked sentence (2026-08-17): deciding between
  // filing an external draft and staging a customer send, the model asked
  // the operator "should I stage it as a send_reply?" instead of describing
  // the outcome in plain language.
  it('strips a reply naming a real registered tool, replacing it with a clean fallback', async () => {
    const result = await runBackOfficeTurn(
      'Also — do you want this drafted into her Drafts folder, or should I stage it as a send_reply?',
      [dummyTool('send_reply'), dummyTool('draft_in_inbox')]
    )
    expect(result.replyText).not.toContain('send_reply')
    expect(result.replyText).not.toBe('')
  })

  it('leaves ordinary text alone when no tool name is mentioned', async () => {
    const result = await runBackOfficeTurn(
      'Want me to send it, or put it in your email drafts?',
      [dummyTool('send_reply'), dummyTool('draft_in_inbox')]
    )
    expect(result.replyText).toBe('Want me to send it, or put it in your email drafts?')
  })

  it('only matches tools actually in this turn\'s registry, not an arbitrary snake_case word', async () => {
    // A business reference code the operator or model might legitimately
    // type is not in the tool vocabulary and must survive untouched.
    const result = await runBackOfficeTurn('Her code is BOOKING_REF_442.', [dummyTool('send_reply')])
    expect(result.replyText).toBe('Her code is BOOKING_REF_442.')
  })
})
