import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

vi.mock('server-only', () => ({}))

/**
 * Full-stack integration test for the 2026-08-17 Bimini revenue-audit fix.
 *
 * Wires the REAL runFounderThreadTurn -> cayeAgent -> runToolLoop ->
 * investigation.ts chain together. Only two things are faked: the
 * Anthropic API boundary (a scripted model that reproduces the actual
 * incident's shape — a big opening batch, more rounds than one pass
 * allows) and Supabase (an in-memory store, so caye_tool_calls and
 * caye_operator_messages are REAL tables as far as the code under test can
 * tell — summarizeInvestigation() reads back rows this same test run
 * actually wrote, not a mock of its own output).
 *
 * This is the closest thing to "run the actual audit" available without a
 * live database and a live model call, and is what sections 9/12 of the
 * merge-safety review ask to be proven directly rather than argued from
 * separate unit tests alone.
 */

// ---- In-memory fake Supabase ---------------------------------------------
interface FakeRow {
  [key: string]: unknown
}
const tables = vi.hoisted(() => new Map<string, FakeRow[]>())
function table(name: string): FakeRow[] {
  if (!tables.has(name)) tables.set(name, [])
  return tables.get(name)!
}
let idCounter = vi.hoisted(() => ({ n: 0 }))

function makeQueryBuilder(rows: FakeRow[]) {
  const filters: Array<(r: FakeRow) => boolean> = []
  const builder = {
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val)
      return builder
    },
    order() {
      return builder
    },
    limit() {
      return builder
    },
    in(col: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[col]))
      return builder
    },
    maybeSingle() {
      const result = rows.filter((r) => filters.every((f) => f(r)))
      return Promise.resolve({ data: result[0] ?? null, error: null })
    },
    single() {
      const result = rows.filter((r) => filters.every((f) => f(r)))
      return Promise.resolve({ data: result[0] ?? null, error: null })
    },
    then(resolve: (v: { data: FakeRow[]; error: null }) => void) {
      const result = rows.filter((r) => filters.every((f) => f(r)))
      resolve({ data: result, error: null })
    },
  }
  return builder
}

const fakeSupabase = {
  from(name: string) {
    return {
      select() {
        return makeQueryBuilder(table(name))
      },
      insert(row: FakeRow) {
        const withId = { id: `${name}-${++idCounter.n}`, ...row }
        table(name).push(withId)
        return {
          select() {
            return { single: () => Promise.resolve({ data: withId, error: null }) }
          },
        }
      },
      // Repository audit, 2026-09-03: runFounderThreadTurn (the wrapper this
      // file exercises via the real import chain) now wraps every non-voice
      // call in a durable run via lib/caye-direct-runs.ts, whose
      // setRunStage/finishDirectRun/failDirectRun/beginDirectRun chain
      // update().eq().eq()/.in().select().maybeSingle()/.single() against
      // caye_direct_runs — a dependency added after this fake's update()
      // was written as a one-shot `{ eq: () => Promise.resolve(...) }`
      // stub with no second filter, no select(), and no actual row
      // mutation. Rebuilt as a real filterable, mutating builder — the
      // same shape makeQueryBuilder already gives reads above — so the
      // rest of this file's "real in-memory table" premise (rows this
      // same test run actually wrote) holds for updates too, not just
      // inserts and reads.
      update(patch: FakeRow) {
        const rows = table(name)
        const filters: Array<(r: FakeRow) => boolean> = []
        const builder = {
          eq(col: string, val: unknown) {
            filters.push((r) => r[col] === val)
            return builder
          },
          in(col: string, vals: unknown[]) {
            filters.push((r) => vals.includes(r[col]))
            return builder
          },
          select() {
            return builder
          },
          apply(): FakeRow[] {
            const matched = rows.filter((r) => filters.every((f) => f(r)))
            for (const r of matched) Object.assign(r, patch)
            return matched
          },
          maybeSingle() {
            const matched = builder.apply()
            return Promise.resolve({ data: matched[0] ?? null, error: null })
          },
          single() {
            const matched = builder.apply()
            return Promise.resolve({ data: matched[0] ?? null, error: null })
          },
          then(resolve: (v: { data: FakeRow[]; error: null }) => void) {
            const matched = builder.apply()
            resolve({ data: matched, error: null })
          },
        }
        return builder
      },
    }
  },
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => fakeSupabase,
}))

// ---- Thread plumbing — mocked (not under test here) ----------------------
vi.mock('@/lib/caye-direct-threads', () => ({
  getThread: async () => ({ id: 'thread-audit', status: 'active', title: null, summary: null }),
  getThreadEntities: async () => [],
  describeEntity: async () => '',
  setThreadStatus: async () => {},
  touchThread: async () => {},
  linkMessageToThread: async () => {},
  linkInsertedMessagesToThreads: async () => {},
}))
vi.mock('@/lib/caye-direct-threads-summarize', () => ({
  maybeGenerateThreadTitle: async () => {},
  maybeRefreshThreadSummary: async () => {},
}))
vi.mock('@/lib/operator-identity', () => ({
  resolveFounderOperator: async () => ({ id: 7, name: 'Lamar', role: 'founder' }),
}))
vi.mock('@/lib/owner-attention', () => ({ loadAttentionDelta: async () => ({}), renderAttentionContext: () => '' }))
vi.mock('@/lib/owner-attention-sync', () => ({ syncOwnerAttention: async () => {} }))
vi.mock('@/lib/model-router/caye-direct-bridge', () => ({
  runCayeDirectRouterTurn: async () => {
    throw new Error('router path must not be used in this test')
  },
}))

// ---- Synthetic tool registry: mirrors the real incident's tool shapes ----
// 60 customers, deliberately sized so ONE pass's full budget (5 rounds x 10
// calls/round = 50 calls) cannot cover them all plus the revenue call —
// this must force at least one real continuation, not just happen to fit.
const customers = Array.from({ length: 60 }, (_, i) => `synthetic-customer-${i}`)
const revenueCalls: unknown[] = []
const customerHistoryCalls: string[] = []

vi.mock('./tools/registry', () => {
  const getRevenue = {
    name: 'get_revenue',
    description: 'test',
    risk: 'read',
    roles: ['founder'],
    modes: ['back-office'],
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      revenueCalls.push(1)
      return { ok: true, data: { total: 9400, bookings: 12 } }
    },
  }
  const getCustomerHistory = {
    name: 'get_customer_history',
    description: 'test',
    risk: 'read',
    roles: ['founder'],
    modes: ['back-office'],
    inputSchema: { type: 'object', properties: { conversation_id: { type: 'string' } } },
    async execute(input: { conversation_id: string }) {
      customerHistoryCalls.push(input.conversation_id)
      return { ok: true, data: { name: input.conversation_id, recent_messages: [] } }
    },
  }
  const scheduleReminder = {
    name: 'schedule_reminder',
    description: 'test — a write tool that must never run during a continuation pass',
    risk: 'low',
    roles: ['founder'],
    modes: ['back-office'],
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      throw new Error('schedule_reminder must never execute in this test — continuations are read-only')
    },
  }
  return { TOOL_REGISTRY: [getRevenue, getCustomerHistory, scheduleReminder] }
})

vi.mock('./modes/back-office', () => ({ buildBackOfficeSystemPrompt: () => 'back-office system prompt' }))

// ---- Scripted "model": reproduces the incident's shape --------------------
// Round 1 of pass 1: a big opening batch (22 get_customer_history calls +
// 1 get_revenue) — like the real incident's "pull everything simultaneously"
// opener. This alone exceeds MAX_TOOL_CALLS_PER_ROUND (10), so most of it
// defers to round 2. By round 5 of pass 1, not everything is done — the
// pass runs out of iterations, exactly like the incident. Continuation
// passes finish covering customers, then pass N synthesizes a real answer
// citing the durable ledger's covered subjects.
let modelCallCount = 0
const toolResultTextOf = (msg: Anthropic.MessageParam): unknown[] =>
  Array.isArray(msg.content) ? msg.content : []

vi.mock('@/lib/llm-telemetry', () => ({
  loggedMessagesCreate: async (
    _client: unknown,
    params: { messages: Anthropic.MessageParam[] }
  ): Promise<Anthropic.Message> => {
    modelCallCount++
    // Determine what's already been covered by scanning tool_result blocks
    // already in this round's message history — the REAL model would do
    // this by reading context; here we do it mechanically to script
    // deterministic behavior without needing a live model.
    const coveredIds = new Set<string>()
    let revenueCovered = false
    for (const msg of params.messages) {
      if (msg.role !== 'user') continue
      for (const block of toolResultTextOf(msg)) {
        const b = block as { type?: string; content?: string }
        if (b.type !== 'tool_result' || typeof b.content !== 'string') continue
        try {
          const parsed = JSON.parse(b.content) as { data?: { name?: string; total?: number } }
          if (parsed.data?.name) coveredIds.add(parsed.data.name)
          if (parsed.data?.total === 9400) revenueCovered = true
        } catch {
          /* deferred/elided placeholders aren't real coverage */
        }
      }
    }
    // Also treat the continuation-digest prompt (a plain user text turn) as
    // a source of "already covered" info — same as the real model reading it.
    for (const msg of params.messages) {
      if (msg.role !== 'user' || typeof msg.content !== 'string') continue
      if (msg.content.includes('get_revenue: ') && msg.content.includes('succeeded')) revenueCovered = true
      const match = msg.content.match(/Already covered \(do not re-fetch\): ([^\n]+)/)
      if (match) {
        for (const id of match[1].split(', ')) coveredIds.add(id.trim().replace(/\.$/, ''))
      }
    }

    const remaining = customers.filter((c) => !coveredIds.has(c))

    if (remaining.length === 0) {
      // Everything covered — synthesize using ONLY grounded identifiers.
      return {
        id: `msg_${modelCallCount}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn', stop_sequence: null,
        content: [
          {
            type: 'text',
            text: `Revenue is $9,400 across 12 bookings. Reviewed ${customers.length} customer threads: ${customers.join(', ')}.`,
          },
        ],
      } as Anthropic.Message
    }

    // Ask for revenue only until it's confirmed covered, plus a batch of
    // not-yet-covered customers — mirrors the real incident's "pull
    // everything" batching behavior without wastefully re-asking for
    // revenue every single round.
    //
    // Batch size (repository audit, 2026-09-03): execute.ts's runToolLoop
    // has never actually enforced a MAX_TOOL_CALLS_PER_ROUND slice — that
    // name only ever existed as a doc comment in investigation-base.ts
    // describing the expected order of magnitude of tool calls a real,
    // token-budgeted model turn produces, not code-enforced batching. This
    // script's batch of 30 was comfortably inside execute.ts's real
    // per-round behavior (every tool_use block in a round executes,
    // uncapped), so all 60 customers finished in a single pass (round 1:
    // 30 + revenue, round 2: the remaining 30, round 3: synthesis) —
    // 3 model calls total, never triggering the continuation loop this
    // test exists to prove. Batching at the documented ~10/round instead
    // reproduces the actual incident shape: one pass's 5 rounds cover at
    // most 50 customers, forcing a genuine continuation pass for the rest.
    const batch = remaining.slice(0, 10)
    return {
      id: `msg_${modelCallCount}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'tool_use', stop_sequence: null,
      content: [
        ...(revenueCovered ? [] : [{ type: 'tool_use' as const, id: `tu_revenue_${modelCallCount}`, name: 'get_revenue', input: {} }]),
        ...batch.map((c, i) => ({
          type: 'tool_use' as const,
          id: `tu_${modelCallCount}_${i}`,
          name: 'get_customer_history',
          input: { conversation_id: c },
        })),
      ],
    } as Anthropic.Message
  },
}))

import { runFounderThreadTurn } from './founder-thread-turn'

describe('Investigation runtime — realistic multi-customer audit, full stack (2026-08-17 Bimini fix)', () => {
  beforeEach(() => {
    tables.clear()
    idCounter.n = 0
    modelCallCount = 0
    revenueCalls.length = 0
    customerHistoryCalls.length = 0
  })

  it('completes a 22-customer audit that exceeds one round, one pass, and requires continuation — automatically, with no fabrication, no duplicate work beyond the ceiling, and no founder-facing retry question', async () => {
    const result = await runFounderThreadTurn(
      'ws-bimini',
      'thread-audit',
      'Perform a comprehensive revenue and growth audit across every customer thread.'
    )

    // 1. It actually finished — a real synthesis, not a placeholder.
    expect(result.replyText).toContain('$9,400')
    for (const c of customers) expect(result.replyText).toContain(c)
    expect(result.replyText).not.toMatch(/platform-side|caching|do you want me to try again/i)

    // 2. Every customer was covered — nothing silently dropped.
    const distinctCovered = new Set(customerHistoryCalls)
    for (const c of customers) expect(distinctCovered.has(c)).toBe(true)

    // 3. No duplicate work: each customer's history was fetched (SUCCESS)
    // at most twice — once in whichever pass first attempted it, and at
    // most once more if that pass ran out of room before executing every
    // request it made (a request made but deferred to a next round is not
    // a duplicate — this bounds redundant re-fetching, it doesn't require
    // literal exactly-once execution, since re-fetch-on-continuation is
    // the documented, intentional recovery path for reads).
    const perCustomerCallCount = new Map<string, number>()
    for (const id of customerHistoryCalls) perCustomerCallCount.set(id, (perCustomerCallCount.get(id) ?? 0) + 1)
    for (const [, count] of perCustomerCallCount) expect(count).toBeLessThanOrEqual(2)

    // 4. The write tool never executed, anywhere, across the whole
    // investigation — continuations are structurally read-only, and the
    // first pass's script never asked for it either.
    // (schedule_reminder throws if called — reaching this line at all
    // means it never ran.)

    // 5. The hard ceiling was never exceeded: at most
    // (1 + MAX_INVESTIGATION_CONTINUATIONS) cayeAgent passes, each at most
    // MAX_TOOL_ITERATIONS model round-trips.
    expect(modelCallCount).toBeLessThanOrEqual(5 * 5)
    // ...and continuation genuinely happened — this isn't passing because
    // 22 customers happened to fit in one pass's 5×10=50-call budget.
    expect(modelCallCount).toBeGreaterThan(5)
    const distinctRequestIds = new Set(table('caye_tool_calls').map((r) => r.request_id))
    expect(distinctRequestIds.size).toBeGreaterThan(1)

    // 6. Same investigation_id across every tool call recorded — the
    // ledger is one coherent record of one investigation, not fragments
    // under different ids.
    const toolCallRows = table('caye_tool_calls')
    expect(toolCallRows.length).toBeGreaterThan(0)
    const investigationIds = new Set(toolCallRows.map((r) => r.investigation_id))
    expect(investigationIds.size).toBe(1)
    expect([...investigationIds][0]).toBeTruthy()

    // 7. Every ledger row is scoped to the right workspace — no
    // cross-workspace leakage even though nothing else in this test
    // exercises a second workspace.
    for (const row of toolCallRows) expect(row.workspace_id).toBe('ws-bimini')

    // 8. Full conversational provenance persisted — every pass's turns
    // reached caye_operator_messages, not just the last pass's.
    const operatorMessages = table('caye_operator_messages')
    const assistantToolUseTurns = operatorMessages.filter(
      (r) => r.direction === 'outbound' && JSON.stringify(r.claude_format).includes('tool_use')
    )
    expect(assistantToolUseTurns.length).toBeGreaterThan(0)

    // 9. The founder was never asked a mid-investigation "should I keep
    // going?" question — recovery was fully automatic. (If it had asked,
    // the scripted model would never have seen a continuation prompt
    // satisfying its coverage check, and the assertions above would have
    // failed by leaving customers uncovered.)
  })

  it('an investigation that genuinely cannot finish still terminates at the hard ceiling with a grounded, non-fabricated partial status — never an infinite loop', async () => {
    // A model that always wants ONE more customer it hasn't seen yet, out
    // of a supply far larger than the entire 250-call ceiling could ever
    // cover. This proves termination is structural (the loop stops because
    // its bounds are exhausted), not because the scripted model happened
    // to cooperate.
    vi.doMock('./tools/registry', () => {
      let n = 0
      const bottomlessCustomerHistory = {
        name: 'get_customer_history',
        description: 'test',
        risk: 'read',
        roles: ['founder'],
        modes: ['back-office'],
        inputSchema: { type: 'object', properties: { conversation_id: { type: 'string' } } },
        async execute(input: { conversation_id: string }) {
          customerHistoryCalls.push(input.conversation_id)
          return { ok: true, data: { name: input.conversation_id } }
        },
      }
      return { TOOL_REGISTRY: [bottomlessCustomerHistory] }
    })
    vi.doMock('@/lib/llm-telemetry', () => ({
      loggedMessagesCreate: async (): Promise<Anthropic.Message> => {
        modelCallCount++
        return {
          id: `msg_${modelCallCount}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'tool_use', stop_sequence: null,
          content: [
            {
              type: 'tool_use',
              id: `tu_${modelCallCount}`,
              name: 'get_customer_history',
              input: { conversation_id: `bottomless-${modelCallCount}` },
            },
          ],
        } as Anthropic.Message
      },
    }))
    vi.resetModules()
    const { runFounderThreadTurn: freshRunFounderThreadTurn } = await import('./founder-thread-turn')

    const result = await freshRunFounderThreadTurn('ws-bimini', 'thread-audit', 'Find every customer, no matter how long it takes.')

    // Terminated — did not hang or throw.
    expect(result.replyText).toBeTruthy()
    // A real, ledger-grounded partial status, never a fabricated "done."
    expect(result.replyText).toMatch(/tool calls across \d+ passes/)
    expect(result.replyText).toContain('Nothing here is invented')
    expect(result.replyText).not.toMatch(/every customer.*found|complete|finished/i)
    // Ceiling respected exactly: 5 passes total.
    const distinctRequestIds = new Set(table('caye_tool_calls').map((r) => r.request_id))
    expect(distinctRequestIds.size).toBe(5)
    // Never more than MAX_TOOL_CALLS_PER_ROUND executed per round, so never
    // more than 5 passes x 5 rounds x 10 calls/round = 250 total.
    expect(table('caye_tool_calls').length).toBeLessThanOrEqual(250)

    vi.doUnmock('./tools/registry')
    vi.doUnmock('@/lib/llm-telemetry')
  })
})
