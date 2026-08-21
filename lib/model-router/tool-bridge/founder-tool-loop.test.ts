import { describe, it, expect, vi } from 'vitest'
import type { Tool, ToolContext } from '@/lib/caye-agent/tools/types'
import type { ToolCapableBackend, ToolTurnResult } from './types'
import type { BackendHealth, FounderRouterContext } from '../types'

vi.mock('server-only', () => ({}))

// Same fire-and-forget caye_tool_calls mock lib/caye-agent/orchestrator.test.ts
// uses — proves runToolWithRecovery's real logging path runs without a real
// Supabase connection, it just never lets a log write affect the result.
const inserted: Record<string, unknown>[] = []
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row)
        return { data: null, error: null }
      },
    }),
  }),
}))

const READ_TOOL: Tool<{ query: string }> = {
  name: 'get_customer',
  description: 'Look up a customer.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  async execute(args) {
    return { ok: true, data: { match: 'unique', contact: { name: `Found: ${args.query}` } } }
  },
}

const READ_TOOL_2: Tool<{ contact_id: string }> = {
  name: 'get_customer_history',
  description: "Get a customer's booking and message history.",
  inputSchema: { type: 'object', properties: { contact_id: { type: 'string' } }, required: ['contact_id'] },
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  async execute(args) {
    return { ok: true, data: { bookings: [], messages: [], for: args.contact_id } }
  },
}

const WRITE_TOOL: Tool<{ note: string }> = {
  name: 'schedule_reminder',
  description: 'Schedule a reminder.',
  inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  async execute() {
    return { ok: true, data: { executed: true } }
  },
}

const STAFF_ONLY_WRITE_TOOL: Tool<Record<string, never>> = {
  name: 'staff_only_action',
  description: 'A write tool founder is not permitted to call, for the role-gate test.',
  inputSchema: { type: 'object', properties: {} },
  risk: 'low',
  roles: ['staff'],
  modes: ['back-office'],
  async execute() {
    return { ok: true, data: {} }
  },
}

const PENDING_WRITE_TOOL: Tool<Record<string, never>> = {
  name: 'send_reply',
  description: 'A high-risk send tool that only stages (gateHighRisk shape: executed:false).',
  inputSchema: { type: 'object', properties: {} },
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  async execute() {
    return { ok: true, data: { executed: false } }
  },
}

vi.mock('@/lib/caye-agent/tools/registry', () => ({
  TOOL_REGISTRY: [READ_TOOL, READ_TOOL_2, WRITE_TOOL, STAFF_ONLY_WRITE_TOOL, PENDING_WRITE_TOOL],
}))

const { runFounderToolLoop, ProtocolViolationError } = await import('./founder-tool-loop')
const { NoBackendAvailableError } = await import('../router')
const { FounderRouterAccessError } = await import('../founder-gate')
const { FABRICATED_TRANSCRIPT_RUN_1, FABRICATED_TRANSCRIPT_RUN_2 } = await import(
  './fixtures/fabricated-tool-transcripts'
)

// Real founder UUID from lib/founder.ts's allowlist (classicalsineus@gmail.com) —
// assertFounderRouterAccess checks against the real allowlist, not a stub.
const FOUNDER_CTX: FounderRouterContext = { founderUserId: '29227a12-ca82-4796-a9c4-30ec0c6fa0e4', threadId: 'thread-1' }

function toolCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: 'ws-1',
    callerRole: 'founder',
    operatorId: 1,
    requestId: 'req-1',
    directThreadLinks: [],
    ...overrides,
  }
}

function textResult(text: string): ToolTurnResult {
  return { content: [{ type: 'text', text, citations: null }], latencyMs: 1 }
}

function toolCallResult(name: string, input: unknown, id = 'call_1'): ToolTurnResult {
  return {
    content: [{ type: 'tool_use', id, name, input: input as Record<string, unknown>, caller: { type: 'direct' } }],
    latencyMs: 1,
  }
}

function fakeBackend(
  id: 'claude_subscription' | 'openai_codex_subscription' | 'anthropic_api',
  invokeTurn: ToolCapableBackend['invokeTurn'],
  health: BackendHealth['state'] = 'available'
): ToolCapableBackend {
  return {
    id,
    provider: id === 'openai_codex_subscription' ? 'openai' : 'anthropic',
    authMode: id === 'anthropic_api' ? 'api_key' : 'subscription_cli',
    capabilities: ['general_reasoning'],
    checkHealth: async () => ({ state: health, checkedAt: new Date().toISOString() }),
    invoke: async () => ({ backend: id, text: 'unused', latencyMs: 1 }),
    invokeTurn,
  }
}

describe('runFounderToolLoop — founder gate', () => {
  it('rejects a non-founder context before touching any backend — non-founder cannot invoke subscription routing', async () => {
    const invokeTurn = vi.fn()
    const backend = fakeBackend('claude_subscription', invokeTurn)
    await expect(
      runFounderToolLoop({
        ctx: { founderUserId: 'a-customer-id', threadId: 'thread-1' },
        requestedMode: 'claude',
        backends: [backend],
        toolCtx: toolCtx(),
        system: 'sys',
        initialMessages: [],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(FounderRouterAccessError)
    expect(invokeTurn).not.toHaveBeenCalled()
  })
})

describe('runFounderToolLoop — internal tool names never reach the founder (2026-08-17 Pam Ott incident)', () => {
  // Mirrors lib/caye-agent/execute.ts's identical guard test — this loop
  // reuses the same lib/operator-text-guard.ts function, wired in
  // separately since Caye Direct/voice run through this loop, not
  // execute.ts's runToolLoop. TOOL_REGISTRY is mocked above to include a
  // real 'send_reply' tool, so this exercises the real vocabulary.
  it('strips a reply naming a real registered tool, replacing it with a clean fallback', async () => {
    const backend = fakeBackend(
      'claude_subscription',
      async () => textResult('Should I stage it as a send_reply, or file it to her drafts?')
    )
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    expect(res.replyText).not.toContain('send_reply')
    expect(res.replyText).not.toBe('')
  })
})

describe('runFounderToolLoop — plain text and provider selection', () => {
  it('a normal text response completes in one round', async () => {
    const backend = fakeBackend('claude_subscription', async () => textResult('Hello, founder.'))
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    expect(res.replyText).toBe('Hello, founder.')
    expect(res.decision.selected).toBe('claude_subscription')
  })

  it('Auto falls back from Claude to Codex when Claude is unavailable', async () => {
    const claude = fakeBackend('claude_subscription', async () => textResult('unused'), 'unavailable')
    const codex = fakeBackend('openai_codex_subscription', async () => textResult('from codex'))
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'auto',
      backends: [claude, codex],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    expect(res.replyText).toBe('from codex')
    expect(res.decision.selected).toBe('openai_codex_subscription')
    expect(res.decision.fallbacksTried).toEqual([{ backend: 'claude_subscription', reason: 'client_unavailable' }])
  })

  it('falls back to the API backend when both subscriptions are unavailable and API fallback is allowed', async () => {
    const claude = fakeBackend('claude_subscription', async () => textResult('unused'), 'unavailable')
    const codex = fakeBackend('openai_codex_subscription', async () => textResult('unused'), 'unavailable')
    const api = fakeBackend('anthropic_api', async () => textResult('from api'))
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'auto',
      backends: [claude, codex, api],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    expect(res.replyText).toBe('from api')
    expect(res.decision.selected).toBe('anthropic_api')
  })

  it('bridge disconnect (all backends unavailable) throws promptly rather than hanging — no fabricated success', async () => {
    const claude = fakeBackend('claude_subscription', async () => textResult('unused'), 'unavailable')
    await expect(
      runFounderToolLoop({
        ctx: FOUNDER_CTX,
        requestedMode: 'claude',
        backends: [claude],
        toolCtx: toolCtx(),
        system: 'sys',
        initialMessages: [],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(NoBackendAvailableError)
  })
})

describe('runFounderToolLoop — real tool execution', () => {
  it('a read-only tool completes end to end through the model/bridge/Caye loop', async () => {
    let round = 0
    const backend = fakeBackend('claude_subscription', async () => {
      round += 1
      if (round === 1) return toolCallResult('get_customer', { query: 'Karenda' })
      return textResult('Found her.')
    })
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    expect(res.replyText).toBe('Found her.')
    // Real runToolWithRecovery ran (not a stub) — the tool_result turn
    // carries the REAL execute() output, not a mocked shortcut.
    const toolResultTurn = res.newTurns[1]
    expect(JSON.stringify(toolResultTurn.content)).toContain('Found: Karenda')
  })

  it('a write tool still goes through its existing role-based authorization gate — unauthorized call never executes', async () => {
    const backend = fakeBackend('claude_subscription', async () => toolCallResult('staff_only_action', {}))
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx({ callerRole: 'founder' }),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    const toolResultTurn = JSON.stringify(res.newTurns[0]) + JSON.stringify(res.newTurns[1])
    expect(toolResultTurn).toContain('is not available to role')
    // The loop degraded (5 iterations of the same rejected call) rather
    // than ever having executed the tool — proven by it never returning a
    // success payload for staff_only_action.
    expect(res.replyText).not.toBe('')
  })

  it('rejects a malformed/untrusted tool call before execution (schema validation)', async () => {
    const backend = fakeBackend('claude_subscription', async (req) => {
      // First call: missing the required `query` field.
      if (req.messages.length === 0) return toolCallResult('get_customer', {})
      return textResult('done')
    })
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    const firstToolResult = JSON.stringify(res.newTurns[1])
    expect(firstToolResult).toContain('Invalid arguments')
    expect(res.replyText).toBe('done')
  })

  it('rejects an unknown tool name cleanly rather than crashing', async () => {
    let round = 0
    const backend = fakeBackend('claude_subscription', async () => {
      round += 1
      if (round === 1) return toolCallResult('delete_entire_database', {})
      return textResult('handled')
    })
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    expect(JSON.stringify(res.newTurns[1])).toContain('Unknown tool')
    expect(res.replyText).toBe('handled')
  })
})

describe('runFounderToolLoop — action grounding (staged/pending cannot be claimed as done)', () => {
  it('strips a "sent" claim when the tool only staged (executed:false) — reuses the exact same action-claim-guard as runToolLoop', async () => {
    let round = 0
    const backend = fakeBackend('claude_subscription', async () => {
      round += 1
      if (round === 1) return toolCallResult('send_reply', {})
      return textResult('I sent that reply to the customer.')
    })
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    expect(res.replyText).not.toContain('I sent that reply')
    expect(res.replyText).toContain('not actually sent')
  })
})

describe('runFounderToolLoop — no cross-provider fallback after a possible side effect', () => {
  it('pins to the backend that attempted a write; a later-round failure surfaces instead of switching providers', async () => {
    let round = 0
    const claude = fakeBackend('claude_subscription', async () => {
      round += 1
      if (round === 1) return toolCallResult('schedule_reminder', { note: 'call back' })
      throw Object.assign(new Error('claude died mid-turn'), { httpStatus: 500 })
    })
    const codexInvoke = vi.fn(async () => textResult('codex should never run'))
    const codex = fakeBackend('openai_codex_subscription', codexInvoke)

    await expect(
      runFounderToolLoop({
        ctx: FOUNDER_CTX,
        requestedMode: 'auto',
        backends: [claude, codex],
        toolCtx: toolCtx(),
        system: 'sys',
        initialMessages: [],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(NoBackendAvailableError)

    expect(codexInvoke).not.toHaveBeenCalled()
  })

  it('a read-only round never pins — provider CAN still switch across pure reads', async () => {
    let round = 0
    const claude = fakeBackend('claude_subscription', async () => {
      round += 1
      if (round === 1) return toolCallResult('get_customer', { query: 'Karenda' })
      throw Object.assign(new Error('claude died mid-turn'), { httpStatus: 500 })
    })
    const codex = fakeBackend('openai_codex_subscription', async () => textResult('codex finished it'))

    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'auto',
      backends: [claude, codex],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    expect(res.replyText).toBe('codex finished it')
  })
})

describe('runFounderToolLoop — restrictToToolNames (structural tool restriction)', () => {
  it('exposes only the named tool — a call to a real registry tool outside the allowlist is rejected as unknown, never executed', async () => {
    let round = 0
    const backend = fakeBackend('claude_subscription', async () => {
      round += 1
      // schedule_reminder is a REAL registry tool (see WRITE_TOOL above) —
      // proves the restriction excludes it structurally, not just that a
      // fictional name gets rejected.
      if (round === 1) return toolCallResult('schedule_reminder', { note: 'x' })
      return textResult('done')
    })
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer'],
    })
    expect(JSON.stringify(res.newTurns[1])).toContain('Unknown tool')
    expect(res.replyText).toBe('done')
  })

  it('allows the one named tool through normally', async () => {
    let round = 0
    const backend = fakeBackend('claude_subscription', async () => {
      round += 1
      if (round === 1) return toolCallResult('get_customer', { query: 'Karenda' })
      return textResult('Found her.')
    })
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer'],
    })
    expect(res.replyText).toBe('Found her.')
  })

  it('omitting restrictToToolNames exposes the full mode-filtered registry, unchanged (default behavior)', async () => {
    let round = 0
    const backend = fakeBackend('claude_subscription', async () => {
      round += 1
      if (round === 1) return toolCallResult('schedule_reminder', { note: 'x' })
      return textResult('done')
    })
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    // Unrestricted: schedule_reminder is a real registered tool, so it
    // executes rather than being rejected as unknown.
    expect(JSON.stringify(res.newTurns[1])).not.toContain('Unknown tool')
  })
})

describe('runFounderToolLoop — iteration bound', () => {
  it('degrades gracefully instead of looping forever when the model keeps calling tools', async () => {
    const backend = fakeBackend('claude_subscription', async () => toolCallResult('get_customer', { query: 'x' }))
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    expect(res.replyText).toMatch(/taking longer than it should/)
  })
})

describe('runFounderToolLoop — protocol-artifact provenance boundary', () => {
  it('regression: the real run-1 fabricated transcript is never returned as replyText, even when the retry also fails', async () => {
    const invokeTurn = vi.fn(async () => textResult(FABRICATED_TRANSCRIPT_RUN_1))
    const backend = fakeBackend('claude_subscription', invokeTurn)
    await expect(
      runFounderToolLoop({
        ctx: FOUNDER_CTX,
        requestedMode: 'claude',
        backends: [backend],
        toolCtx: toolCtx(),
        system: 'sys',
        initialMessages: [{ role: 'user', content: 'Look up Juli King and her history.' }],
        signal: new AbortController().signal,
        restrictToToolNames: ['get_customer', 'get_customer_history'],
      })
    ).rejects.toThrow(ProtocolViolationError)
    // First attempt + exactly one retry — never more.
    expect(invokeTurn).toHaveBeenCalledTimes(2)
  })

  it('regression: the real run-2 fabricated transcript is also caught and never returned', async () => {
    const backend = fakeBackend('claude_subscription', async () => textResult(FABRICATED_TRANSCRIPT_RUN_2))
    await expect(
      runFounderToolLoop({
        ctx: FOUNDER_CTX,
        requestedMode: 'claude',
        backends: [backend],
        toolCtx: toolCtx(),
        system: 'sys',
        initialMessages: [{ role: 'user', content: 'Look up Juli King and her history.' }],
        signal: new AbortController().signal,
        restrictToToolNames: ['get_customer', 'get_customer_history'],
      })
    ).rejects.toThrow(ProtocolViolationError)
  })

  it('recovers cleanly when the retry produces a genuine final answer — fabricated data never reaches replyText', async () => {
    // Uses a non-grounding-required question (see business-grounding-
    // classifier.test.ts) so this test isolates protocol-violation-retry
    // recovery specifically, independent of the separate grounding
    // invariant covered in its own describe block below.
    let call = 0
    const invokeTurn = vi.fn(async () => {
      call += 1
      if (call === 1) return textResult(FABRICATED_TRANSCRIPT_RUN_1)
      return textResult('Here is what I can help with.')
    })
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'What can you do?' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    expect(res.replyText).toBe('Here is what I can help with.')
    expect(res.replyText).not.toContain('juli.king@gmail.com') // the fabricated email from run 1
    expect(invokeTurn).toHaveBeenCalledTimes(2)
  })

  it('recovers cleanly when the retry produces a genuine structured tool request — proceeds to real execution normally', async () => {
    let call = 0
    const invokeTurn = vi.fn(async () => {
      call += 1
      if (call === 1) return textResult(FABRICATED_TRANSCRIPT_RUN_1)
      if (call === 2) return toolCallResult('get_customer', { query: 'Juli King' })
      return textResult('Found: real data only.')
    })
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'Look up Juli King.' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    expect(res.replyText).toBe('Found: real data only.')
    // The real READ_TOOL executed for real (its own canned response), not the fabricated one.
    expect(JSON.stringify(res.newTurns)).toContain('Found: Juli King')
  })

  it('never persists the correction prompt or the fabricated content into newTurns, win or lose', async () => {
    let call = 0
    const invokeTurn = vi.fn(async () => {
      call += 1
      if (call === 1) return textResult(FABRICATED_TRANSCRIPT_RUN_1)
      return textResult('Clean answer.')
    })
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    const serialized = JSON.stringify(res.newTurns)
    expect(serialized).not.toContain('juli.king@gmail.com')
    expect(serialized).not.toContain('did not follow the tool protocol') // the correction text itself
    expect(res.replyText).toBe('Clean answer.')
  })

  it('a genuinely clean text response (no protocol artifacts) is accepted on the first try, no retry triggered', async () => {
    const invokeTurn = vi.fn(async () => textResult('She asked about pricing. No booking on file.'))
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    expect(res.replyText).toBe('She asked about pricing. No booking on file.')
    expect(invokeTurn).toHaveBeenCalledTimes(1)
  })

  it('a genuine structured tool_use round is never routed through the guard/retry path at all', async () => {
    let round = 0
    const invokeTurn = vi.fn(async () => {
      round += 1
      if (round === 1) return toolCallResult('get_customer', { query: 'x' })
      return textResult('Grounded answer.')
    })
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [],
      signal: new AbortController().signal,
    })
    expect(res.replyText).toBe('Grounded answer.')
    // Exactly 2 real rounds (tool call + final text) — no extra retry calls.
    expect(invokeTurn).toHaveBeenCalledTimes(2)
  })

  it('does not execute any real tool while a fabricated transcript is being rejected/retried', async () => {
    const executeSpy = vi.fn(async (args: { query: string }) => ({
      ok: true,
      data: { match: 'unique', contact: { name: `Found: ${args.query}` } },
    }))
    const spiedReadTool: Tool<{ query: string }> = { ...READ_TOOL, execute: executeSpy }
    // Rebuild backend against a registry that would let us detect a call —
    // simplest is to assert on the module-level READ_TOOL mock's own
    // execute via TOOL_REGISTRY mock already in place; spiedReadTool here
    // exists only to document intent, the real assertion is that
    // caye_tool_calls-shaped inserts (the `inserted` array) stay empty for
    // this run.
    const before = inserted.length
    const backend = fakeBackend('claude_subscription', async () => textResult(FABRICATED_TRANSCRIPT_RUN_2))
    await expect(
      runFounderToolLoop({
        ctx: FOUNDER_CTX,
        requestedMode: 'claude',
        backends: [backend],
        toolCtx: toolCtx(),
        system: 'sys',
        initialMessages: [],
        signal: new AbortController().signal,
        restrictToToolNames: ['get_customer', 'get_customer_history'],
      })
    ).rejects.toThrow(ProtocolViolationError)
    expect(inserted.length).toBe(before) // no caye_tool_calls row was written
    void executeSpy
    void spiedReadTool
  })
})

describe('runFounderToolLoop — business-grounding invariant (CORE INVARIANT #2)', () => {
  it('1. business-data request + immediate text answer: rejected, never returned, forces another round', async () => {
    let call = 0
    const invokeTurn = vi.fn(async () => {
      call += 1
      // Every attempt answers directly with fabricated-but-clean text, no
      // tool call, no protocol artifacts — exactly the real Claude failure.
      return textResult(`Juli King — fake${call}@example.com. Booking confirmed.`)
    })
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'Who is Juli King?' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    // Fails closed after exhausting the round budget — never returns the fabricated text.
    expect(res.replyText).not.toContain('fake')
    expect(res.replyText).not.toContain('@example.com')
    expect(res.replyText).toMatch(/wasn't able to verify/i)
    expect(invokeTurn).toHaveBeenCalledTimes(5) // MAX_TOOL_ITERATIONS, all rejected
    // No fabricated turn was ever persisted.
    expect(JSON.stringify(res.newTurns)).not.toContain('fake')
  })

  it('2. business-data request + proper tool call: executes once, real result enters next round, grounded answer accepted', async () => {
    let round = 0
    const invokeTurn = vi.fn(async () => {
      round += 1
      if (round === 1) return toolCallResult('get_customer', { query: 'Juli King' })
      return textResult('Found: Juli King, per the real record.')
    })
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'Who is Juli King?' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    expect(res.replyText).toBe('Found: Juli King, per the real record.')
    expect(invokeTurn).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(res.newTurns)).toContain('Found: Juli King') // real READ_TOOL execute() output
  })

  it('3. business-data request requiring two reads: both execute exactly once, final answer accepted only after both', async () => {
    let round = 0
    const invokeTurn = vi.fn(async () => {
      round += 1
      if (round === 1) return toolCallResult('get_customer', { query: 'Juli King' }, 'call_1')
      if (round === 2) return toolCallResult('get_customer_history', { contact_id: 'Found: Juli King' }, 'call_2')
      return textResult('Grounded answer using both real results.')
    })
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'Look up Juli King and her booking history.' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    expect(res.replyText).toBe('Grounded answer using both real results.')
    expect(invokeTurn).toHaveBeenCalledTimes(3)
    const serialized = JSON.stringify(res.newTurns)
    expect(serialized).toContain('get_customer')
    expect(serialized).toContain('get_customer_history')
    // Exactly one execution each — count tool_use occurrences.
    const toolUseCount = res.newTurns.filter(
      (t) => Array.isArray(t.content) && t.content.some((b: { type: string }) => b.type === 'tool_use')
    ).length
    expect(toolUseCount).toBe(2)
  })

  it('4. business-data request + model repeatedly refuses to use tools: fails closed, no fabricated final answer', async () => {
    const invokeTurn = vi.fn(async () => textResult('I think her email is probably jking@example.com based on common patterns.'))
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'What is her email?' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    expect(res.replyText).not.toContain('jking@example.com')
    expect(res.replyText).toMatch(/wasn't able to verify/i)
    expect(invokeTurn).toHaveBeenCalledTimes(5)
  })

  it('5. non-business/general conversation: answers normally, zero tool executions', async () => {
    const invokeTurn = vi.fn(async () => textResult('I can look up customers, bookings, and draft replies for you.'))
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'What can you do?' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    expect(res.replyText).toBe('I can look up customers, bookings, and draft replies for you.')
    expect(invokeTurn).toHaveBeenCalledTimes(1) // no forcing at all
  })

  it('6. drafting/reasoning request with all facts supplied inline: no forced workspace read', async () => {
    const invokeTurn = vi.fn(async () => textResult('Sure — here is a cleaner version: "We are closed on Sundays."'))
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'Rewrite this: "we r closed sundays"' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    expect(res.replyText).toContain('closed on Sundays')
    expect(invokeTurn).toHaveBeenCalledTimes(1)
  })

  it('7. protocol-artifact violations: existing retry behavior still works alongside the grounding invariant', async () => {
    let call = 0
    const invokeTurn = vi.fn(async () => {
      call += 1
      if (call === 1) return textResult(FABRICATED_TRANSCRIPT_RUN_1) // protocol violation
      if (call === 2) return toolCallResult('get_customer', { query: 'Juli King' }) // clean retry: real tool call
      return textResult('Grounded, from the real record.')
    })
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'Who is Juli King?' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    expect(res.replyText).toBe('Grounded, from the real record.')
    expect(call).toBe(3)
  })

  it('8. no duplicate tool executions across a grounding-forced sequence', async () => {
    let round = 0
    const invokeTurn = vi.fn(async () => {
      round += 1
      if (round === 1) return textResult('Let me think about that.') // rejected — no tool, forced retry
      if (round === 2) return toolCallResult('get_customer', { query: 'Juli King' })
      return textResult('Grounded answer.')
    })
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'Who is Juli King?' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    expect(res.replyText).toBe('Grounded answer.')
    const toolUseCount = res.newTurns.filter(
      (t) => Array.isArray(t.content) && t.content.some((b: { type: string }) => b.type === 'tool_use')
    ).length
    expect(toolUseCount).toBe(1) // get_customer executed exactly once, not twice
  })

  it('9. a rejected ungrounded first-answer attempt never enters messages or newTurns', async () => {
    let round = 0
    const invokeTurn = vi.fn(async () => {
      round += 1
      if (round === 1) return textResult('Her email is definitely fake-invented@nowhere.test.')
      return textResult('Actually, real grounded answer.')
    })
    // Round 2 also has no tool call — grounding is still unmet, so this
    // keeps forcing until the round budget is spent; assert the rejected
    // text from round 1 never leaks into newTurns even though the loop
    // ultimately fails closed.
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'What is her email?' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    const serialized = JSON.stringify(res.newTurns)
    expect(serialized).not.toContain('fake-invented@nowhere.test')
    expect(res.replyText).not.toContain('fake-invented@nowhere.test')
  })

  it('10. round-limit behavior remains safe: exhausting the bound while ungrounded returns the honest ungrounded message, not the generic degrade', async () => {
    const invokeTurn = vi.fn(async () => textResult('Invented answer every time.'))
    const backend = fakeBackend('claude_subscription', invokeTurn)
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'Who still owes us money?' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    expect(invokeTurn).toHaveBeenCalledTimes(5)
    expect(res.replyText).toMatch(/wasn't able to verify/i)
    expect(res.replyText).not.toBe("Sorry, that one's taking longer than it should — give me a moment and try again.")
  })

  it('the pre-existing generic round-limit degrade message is still used when grounding was never required', async () => {
    const backend = fakeBackend('claude_subscription', async () => toolCallResult('get_customer', { query: 'x' }))
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'claude',
      backends: [backend],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [], // no user text -> requiresBusinessGrounding('') is false
      signal: new AbortController().signal,
    })
    expect(res.replyText).toBe("Sorry, that one's taking longer than it should — give me a moment and try again.")
  })

  it('grounding forcing does not pin the backend chain (unlike a real write attempt) — Auto may still fall back across forced rounds', async () => {
    let claudeCalls = 0
    const claude = fakeBackend('claude_subscription', async () => {
      claudeCalls += 1
      throw Object.assign(new Error('claude down'), { httpStatus: 500 })
    })
    const codex = fakeBackend('openai_codex_subscription', async () => toolCallResult('get_customer', { query: 'x' }))
    // Second round: codex answers with a real result.
    let codexRound = 0
    codex.invokeTurn = vi.fn(async () => {
      codexRound += 1
      if (codexRound === 1) return toolCallResult('get_customer', { query: 'x' })
      return textResult('Grounded via codex.')
    })
    const res = await runFounderToolLoop({
      ctx: FOUNDER_CTX,
      requestedMode: 'auto',
      backends: [claude, codex],
      toolCtx: toolCtx(),
      system: 'sys',
      initialMessages: [{ role: 'user', content: 'Who is Juli King?' }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    expect(res.replyText).toBe('Grounded via codex.')
    void claudeCalls
  })
})
