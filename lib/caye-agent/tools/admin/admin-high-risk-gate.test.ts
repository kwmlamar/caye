import { describe, it, expect, vi } from 'vitest'
import type { Tool, ToolContext } from '../types'
// vi.mock calls below are hoisted above this import by vitest's transform,
// so the mocked '@/lib/supabase-server' is already in place when this
// module (and its 'server-only' import) loads.
import { gateAdminHighRisk } from './admin-high-risk-gate'

vi.mock('server-only', () => ({}))

// Same minimal in-memory fake as high-risk-gate.test.ts, trimmed to the
// chain admin-high-risk-gate.ts actually uses: no operator_id filtering
// (admin-shell has a single caller, no operator scoping concept).
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
  cron_name: string
}

function makeRealTool(mutate: Tool<FakeArgs>['execute']): Tool<FakeArgs> {
  return {
    name: 'trigger_cron',
    description: 'test tool',
    risk: 'high',
    roles: ['founder'],
    modes: ['admin-shell'],
    inputSchema: {
      type: 'object',
      properties: { cron_name: { type: 'string' } },
      required: ['cron_name'],
    },
    execute: mutate,
  }
}

function ctx(overrides: Partial<ToolContext>): ToolContext {
  return {
    workspaceId: '00000000-0000-0000-0000-000000000000',
    callerRole: 'founder',
    operatorId: null,
    requestId: 'req-default',
    ...overrides,
  }
}

// admin_pending_actions has no workspace_id column (admin-shell is
// workspace-less, single-caller) — unlike high-risk-gate.test.ts, there's
// no natural per-test isolation dimension to key the fake rows by. Each
// test below uses a distinct cron_name value purely to avoid cross-test
// row collisions against the one shared fakeSupabase instance.
describe('gateAdminHighRisk (Admin Shell — 2026-07-21)', () => {
  it('stages the first call and does not run the real mutation', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { ran: true } }))
    const gated = gateAdminHighRisk(makeRealTool(mutate))

    const result = await gated.execute({ cron_name: 'test-alpha' }, ctx({ requestId: 'req-1' }))

    expect(mutate).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect((result.data as { pending?: boolean }).pending).toBe(true)
  })

  it('does not execute on a same-request retry with the same args', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { ran: true } }))
    const gated = gateAdminHighRisk(makeRealTool(mutate))
    const sameCtx = ctx({ requestId: 'req-2' })

    await gated.execute({ cron_name: 'test-beta' }, sameCtx)
    const second = await gated.execute({ cron_name: 'test-beta' }, sameCtx)

    expect(mutate).not.toHaveBeenCalled()
    expect((second.data as { pending?: boolean }).pending).toBe(true)
  })

  it('executes for real once the same args are confirmed from a different request', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { ran: true } }))
    const gated = gateAdminHighRisk(makeRealTool(mutate))

    await gated.execute({ cron_name: 'test-gamma' }, ctx({ requestId: 'req-3' }))
    const confirmed = await gated.execute({ cron_name: 'test-gamma' }, ctx({ requestId: 'req-4' }))

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(confirmed).toEqual({ ok: true, data: { ran: true } })
  })

  it('stages a fresh action when the confirming call has different args', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { ran: true } }))
    const gated = gateAdminHighRisk(makeRealTool(mutate))

    await gated.execute({ cron_name: 'test-delta' }, ctx({ requestId: 'req-5' }))
    // Confirming call uses a DIFFERENT cron_name — should stage fresh,
    // not execute the originally-staged action.
    const result = await gated.execute({ cron_name: 'test-epsilon' }, ctx({ requestId: 'req-6' }))

    expect(mutate).not.toHaveBeenCalled()
    expect((result.data as { pending?: boolean }).pending).toBe(true)
  })
})
