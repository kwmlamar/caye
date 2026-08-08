import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tool, ToolContext } from '../types'

vi.mock('server-only', () => ({}))

type Row = Record<string, unknown>
const rows: Row[] = []

/**
 * Fake of the supabase chains confirm-pending-action.ts uses:
 *   from().select().eq().eq()/is().maybeSingle()
 *   from().update().eq().is().select().maybeSingle()   (the atomic claim)
 *   from().update().eq()                                (the result write)
 */
function makeFakeSupabase() {
  return {
    from(_table: string) {
      return {
        select(_cols: string) {
          const filters: Array<(r: Row) => boolean> = []
          const b = {
            eq(col: string, val: unknown) {
              filters.push((r) => r[col] === val)
              return b
            },
            is(col: string, val: null) {
              filters.push((r) => (r[col] ?? null) === val)
              return b
            },
            async maybeSingle() {
              return { data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }
            },
          }
          return b
        },
        update(patch: Row) {
          return {
            eq(col: string, val: unknown) {
              const filters: Array<(r: Row) => boolean> = [(r) => r[col] === val]
              const b = {
                is(c: string, v: null) {
                  filters.push((r) => (r[c] ?? null) === v)
                  return b
                },
                select() {
                  return b
                },
                async maybeSingle() {
                  const row = rows.find((r) => filters.every((f) => f(r)))
                  if (!row) return { data: null, error: null }
                  Object.assign(row, patch)
                  return { data: { id: row.id }, error: null }
                },
                then(resolve: (v: unknown) => unknown) {
                  const row = rows.find((r) => filters.every((f) => f(r)))
                  if (row) Object.assign(row, patch)
                  return Promise.resolve({ data: row ?? null, error: null }).then(resolve)
                },
              }
              return b
            },
          }
        },
      }
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => makeFakeSupabase() }))

// The tool the staged row points at. Records what args it actually ran with —
// which is the whole point of the fix.
const ran: unknown[] = []
const targetTool: Tool<{ body: string }> = {
  name: 'send_reply',
  description: 'fake',
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: { type: 'object', properties: {}, required: [] },
  async execute(args) {
    ran.push(args)
    return { ok: true, data: { sent: true } }
  },
}

vi.mock('../high-risk-registry', () => ({
  findHighRiskTool: (name: string) => (name === 'send_reply' ? targetTool : undefined),
  HIGH_RISK_TOOLS: [],
}))

import { confirmPendingAction } from './confirm-pending-action'

const STAGED_BODY = 'Hey,\n\nJust checking in — did you get a chance to try the demo?'
const FUTURE = () => new Date(Date.now() + 10 * 60 * 1000).toISOString()

function stage(overrides: Row = {}): string {
  const id = `pa-${rows.length + 1}`
  rows.push({
    id,
    workspace_id: 'ws-1',
    operator_id: 20,
    tool_name: 'send_reply',
    args: { body: STAGED_BODY, conversation_id: 'conv-1' },
    summary: 'Send to Zanzibar Holidays One (email): …',
    created_in_request_id: 'req-staged',
    expires_at: FUTURE(),
    executed_at: null,
    cancelled_at: null,
    ...overrides,
  })
  return id
}

function ctx(o: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: 'ws-1',
    callerRole: 'owner',
    operatorId: 20,
    requestId: 'req-confirming',
    ...o,
  } as ToolContext
}

beforeEach(() => {
  rows.length = 0
  ran.length = 0
})

describe('confirm_pending_action — executes what was shown', () => {
  it('runs the STAGED args, not anything re-derived', async () => {
    // The bug this replaces: the model reworded the draft, so its confirming
    // call no longer matched the staged args and staged a second row instead
    // of sending. Confirming by id makes the model's wording irrelevant.
    const id = stage()
    const result = await confirmPendingAction.execute({ pending_action_id: id }, ctx())

    expect(result.ok).toBe(true)
    expect(ran).toHaveLength(1)
    expect(ran[0]).toEqual({ body: STAGED_BODY, conversation_id: 'conv-1' })
    expect(rows[0].executed_at).not.toBeNull()
  })

  it('marks the row executed so it cannot be replayed', async () => {
    const id = stage()
    await confirmPendingAction.execute({ pending_action_id: id }, ctx())
    const second = await confirmPendingAction.execute({ pending_action_id: id }, ctx())

    expect(second.ok).toBe(false)
    expect(ran).toHaveLength(1)
  })

  it('runs once when two confirmations race', async () => {
    // Both pass the read-time checks; the conditional update is the real
    // mutual exclusion. A duplicate customer send is not recoverable.
    const id = stage()
    const [a, b] = await Promise.all([
      confirmPendingAction.execute({ pending_action_id: id }, ctx()),
      confirmPendingAction.execute({ pending_action_id: id }, ctx()),
    ])

    expect(ran).toHaveLength(1)
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
  })
})

describe('confirm_pending_action — refuses', () => {
  it('an action staged in this same turn', async () => {
    const id = stage({ created_in_request_id: 'req-confirming' })
    const result = await confirmPendingAction.execute({ pending_action_id: id }, ctx())
    expect(result.ok).toBe(false)
    expect(ran).toHaveLength(0)
  })

  it('an expired action', async () => {
    const id = stage({ expires_at: new Date(Date.now() - 1000).toISOString() })
    const result = await confirmPendingAction.execute({ pending_action_id: id }, ctx())
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/expired/i)
    expect(ran).toHaveLength(0)
  })

  it('a cancelled action', async () => {
    const id = stage({ cancelled_at: new Date().toISOString() })
    expect((await confirmPendingAction.execute({ pending_action_id: id }, ctx())).ok).toBe(false)
    expect(ran).toHaveLength(0)
  })

  it('a scan-origin confirmation', async () => {
    const id = stage()
    const result = await confirmPendingAction.execute(
      { pending_action_id: id },
      ctx({ origin: 'scan' } as Partial<ToolContext>)
    )
    expect(result.ok).toBe(false)
    expect(ran).toHaveLength(0)
  })

  it('another operator confirming', async () => {
    const id = stage({ operator_id: 20 })
    const result = await confirmPendingAction.execute({ pending_action_id: id }, ctx({ operatorId: 99 }))
    expect(result.ok).toBe(false)
    expect(ran).toHaveLength(0)
  })

  it('another workspace confirming', async () => {
    const id = stage()
    const result = await confirmPendingAction.execute(
      { pending_action_id: id },
      ctx({ workspaceId: 'ws-other' })
    )
    expect(result.ok).toBe(false)
    expect(ran).toHaveLength(0)
  })

  it('a role the TARGET tool does not permit', async () => {
    // Confirming must not widen access — send_reply is owner/founder only.
    const id = stage()
    const result = await confirmPendingAction.execute({ pending_action_id: id }, ctx({ callerRole: 'driver' }))
    expect(result.ok).toBe(false)
    expect(ran).toHaveLength(0)
  })

  it('a staged tool that is not high-risk-registered', async () => {
    const id = stage({ tool_name: 'some_other_tool' })
    expect((await confirmPendingAction.execute({ pending_action_id: id }, ctx())).ok).toBe(false)
    expect(ran).toHaveLength(0)
  })
})
