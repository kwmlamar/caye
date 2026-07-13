import { describe, it, expect, vi } from 'vitest'
import type { Tool, ToolContext, ToolResult } from './types'
// vi.mock calls below are hoisted above this import by vitest's transform,
// so the mocked '@/lib/supabase-server' is already in place when this
// module (and its 'server-only' import) loads.
import { gateHighRisk } from './high-risk-gate'

// Neutralize the 'server-only' guard so vitest (node env) can load the
// agent modules. Vitest doesn't ship a server boundary.
vi.mock('server-only', () => ({}))

// Minimal in-memory fake of the one supabase-js chain shape
// high-risk-gate.ts actually uses: from().select().eq/is/gt().order()
// .limit().maybeSingle(), from().insert(), from().update().eq(). Each
// test uses its own workspaceId so rows never leak across tests.
type Row = Record<string, unknown>

function makeFakeSupabase() {
  const rows: Row[] = []
  const client = {
    from(_table: string) {
      return {
        select(_cols: string) {
          const filters: Array<(row: Row) => boolean> = []
          const builder = {
            eq(col: string, val: unknown) {
              filters.push((row) => row[col] === val)
              return builder
            },
            is(col: string, val: null) {
              filters.push((row) => (row[col] ?? null) === val)
              return builder
            },
            gt(col: string, val: string) {
              filters.push((row) => (row[col] as string) > val)
              return builder
            },
            order() {
              return builder
            },
            limit() {
              return builder
            },
            async maybeSingle() {
              const matches = rows.filter((r) => filters.every((f) => f(r)))
              return { data: matches[matches.length - 1] ?? null, error: null }
            },
          }
          return builder
        },
        insert(row: Row) {
          return Promise.resolve().then(() => {
            const full = { id: `row_${rows.length}`, ...row }
            rows.push(full)
            return { data: full, error: null }
          })
        },
        update(patch: Row) {
          return {
            eq(col: string, val: unknown) {
              const row = rows.find((r) => r[col] === val)
              if (row) Object.assign(row, patch)
              return Promise.resolve({ data: row ?? null, error: null })
            },
          }
        },
      }
    },
  }
  return client
}

const fakeSupabase = makeFakeSupabase()

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => fakeSupabase,
}))

interface FakeArgs {
  target: string
}

function makeRealTool(mutate: Tool<FakeArgs>['execute']): Tool<FakeArgs> {
  return {
    name: 'fake_high_risk_tool',
    description: 'test tool',
    risk: 'high',
    roles: ['owner', 'founder'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    },
    execute: mutate,
  }
}

function ctx(overrides: Partial<ToolContext>): ToolContext {
  return {
    workspaceId: 'ws-default',
    callerRole: 'owner',
    operatorId: 1,
    requestId: 'req-default',
    ...overrides,
  }
}

describe('gateHighRisk (#64 — code-enforced confirmation gate)', () => {
  it('stages the first call and does not run the real mutation', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { mutated: true } }))
    const gated = gateHighRisk(makeRealTool(mutate))

    const result = await gated.execute(
      { target: 'alpha' },
      ctx({ workspaceId: 'ws-1', requestId: 'req-1' })
    )

    expect(mutate).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect((result.data as { pending?: boolean }).pending).toBe(true)
  })

  it('does not execute on a same-request retry with the same args', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { mutated: true } }))
    const gated = gateHighRisk(makeRealTool(mutate))
    const sameCtx = ctx({ workspaceId: 'ws-2', requestId: 'req-1' })

    await gated.execute({ target: 'alpha' }, sameCtx)
    const second = await gated.execute({ target: 'alpha' }, sameCtx)

    expect(mutate).not.toHaveBeenCalled()
    expect((second.data as { pending?: boolean }).pending).toBe(true)
  })

  it('executes for real once the same args are confirmed from a different request', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { mutated: true } }))
    const gated = gateHighRisk(makeRealTool(mutate))

    await gated.execute({ target: 'alpha' }, ctx({ workspaceId: 'ws-3', requestId: 'req-1' }))
    const confirmed = await gated.execute(
      { target: 'alpha' },
      ctx({ workspaceId: 'ws-3', requestId: 'req-2' })
    )

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(confirmed).toEqual({ ok: true, data: { mutated: true } })
  })

  it('stages a fresh action when the confirming call has different args', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { mutated: true } }))
    const gated = gateHighRisk(makeRealTool(mutate))

    await gated.execute({ target: 'alpha' }, ctx({ workspaceId: 'ws-4', requestId: 'req-1' }))
    // Operator changed their mind — different args on the "confirming" turn.
    const result = await gated.execute(
      { target: 'beta' },
      ctx({ workspaceId: 'ws-4', requestId: 'req-2' })
    )

    expect(mutate).not.toHaveBeenCalled()
    expect((result.data as { pending?: boolean }).pending).toBe(true)
  })

  it('scopes staged actions per operator — a different operator cannot confirm someone else\'s stage', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { mutated: true } }))
    const gated = gateHighRisk(makeRealTool(mutate))

    await gated.execute(
      { target: 'alpha' },
      ctx({ workspaceId: 'ws-5', operatorId: 1, requestId: 'req-1' })
    )
    const otherOperator = await gated.execute(
      { target: 'alpha' },
      ctx({ workspaceId: 'ws-5', operatorId: 2, requestId: 'req-2' })
    )

    expect(mutate).not.toHaveBeenCalled()
    expect((otherOperator.data as { pending?: boolean }).pending).toBe(true)
  })
})
