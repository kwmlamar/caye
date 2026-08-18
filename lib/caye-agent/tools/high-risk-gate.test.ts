import { describe, it, expect, vi } from 'vitest'
import type { Tool, ToolContext, ToolResult } from './types'
// vi.mock calls below are hoisted above this import by vitest's transform,
// so the mocked '@/lib/supabase-server' is already in place when this
// module (and its 'server-only' import) loads.
import { gateHighRisk } from './high-risk-gate'

vi.mock('server-only', () => ({}))

type Row = Record<string, unknown>

function makeFakeSupabase() {
  const rows: Row[] = []
  const client = {
    __rows: rows,
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
            then(resolve: (v: { data: Row[]; error: null }) => void) {
              resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null })
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

interface FakeSendArgs {
  conversation_id: string
  body: string
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
    const data = result.data as Record<string, unknown>
    expect(data.pending).toBe(true)
    expect(data).not.toHaveProperty('expires_in_minutes')
    expect(String(data.note)).toMatch(/do not mention timing windows/i)
  })

  it('still stores an internal expiration timestamp for stale-authorization safety', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true }))
    const gated = gateHighRisk(makeRealTool(mutate))
    const before = Date.now()

    await gated.execute(
      { target: 'ttl-internal' },
      ctx({ workspaceId: 'ws-ttl-internal', requestId: 'req-ttl' })
    )

    const row = fakeSupabase.__rows.find((r) => r.workspace_id === 'ws-ttl-internal')
    expect(row).toBeTruthy()
    const expires = Date.parse(row!.expires_at as string)
    expect(expires).toBeGreaterThan(before)
    expect(expires).toBeLessThanOrEqual(before + 16 * 60 * 1000)
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
    const result = await gated.execute(
      { target: 'beta' },
      ctx({ workspaceId: 'ws-4', requestId: 'req-2' })
    )

    expect(mutate).not.toHaveBeenCalled()
    expect((result.data as { pending?: boolean }).pending).toBe(true)
  })

  it('opportunity-scan: a second scan run never auto-executes a proposal it staged itself', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { mutated: true } }))
    const gated = gateHighRisk(makeRealTool(mutate))
    const wsId = 'ws-scan-1'

    await gated.execute({ target: 'alpha' }, ctx({ workspaceId: wsId, requestId: 'scan-req-1', origin: 'scan' }))
    const secondScan = await gated.execute(
      { target: 'alpha' },
      ctx({ workspaceId: wsId, requestId: 'scan-req-2', origin: 'scan' })
    )

    expect(mutate).not.toHaveBeenCalled()
    expect((secondScan.data as { pending?: boolean }).pending).toBe(true)

    const realConfirm = await gated.execute(
      { target: 'alpha' },
      ctx({ workspaceId: wsId, requestId: 'chat-req-1' })
    )

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(realConfirm).toEqual({ ok: true, data: { mutated: true } })
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

describe('gateHighRisk supersession (Phase 3, Part E — refinement of a staged draft)', () => {
  function makeSendTool(mutate: Tool<FakeSendArgs>['execute']): Tool<FakeSendArgs> {
    return {
      name: 'fake_send_reply',
      description: 'test send tool',
      risk: 'high',
      roles: ['owner', 'founder'],
      modes: ['back-office'],
      inputSchema: {
        type: 'object',
        properties: { conversation_id: { type: 'string' }, body: { type: 'string' } },
        required: ['conversation_id', 'body'],
      },
      execute: mutate,
    }
  }

  it('cancels the older staged draft for the same conversation_id when a refinement stages a new one', async () => {
    const mutate = vi.fn<Tool<FakeSendArgs>['execute']>(async () => ({ ok: true, data: { sent: true } }))
    const gated = gateHighRisk(makeSendTool(mutate))
    const wsId = 'ws-supersede-1'

    const first = await gated.execute(
      { conversation_id: 'conv-1', body: 'Tell them Max will greet them at 11.' },
      ctx({ workspaceId: wsId, requestId: 'req-1' })
    )
    const firstId = (first.data as { pending_action_id: string }).pending_action_id

    const second = await gated.execute(
      { conversation_id: 'conv-1', body: 'Tell them Max will greet them at 11. Safe travels!' },
      ctx({ workspaceId: wsId, requestId: 'req-1' })
    )
    const secondId = (second.data as { pending_action_id: string }).pending_action_id

    expect(secondId).not.toBe(firstId)
  })
})
