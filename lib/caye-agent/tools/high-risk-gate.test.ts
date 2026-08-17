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
            // Real supabase-js query builders are thenable: awaiting one
            // WITHOUT narrowing via .maybeSingle()/.single() resolves to
            // every matching row as an array — the shape gateHighRisk's
            // supersession lookup relies on (Phase 3, Part E).
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

  it('opportunity-scan (2026-07-28): a second scan run never auto-executes a proposal it staged itself', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { mutated: true } }))
    const gated = gateHighRisk(makeRealTool(mutate))
    const wsId = 'ws-scan-1'

    await gated.execute({ target: 'alpha' }, ctx({ workspaceId: wsId, requestId: 'scan-req-1', origin: 'scan' }))
    // A later, independent scan run reasons its way to the same proposal —
    // different requestId, same args, still origin: 'scan'. Must NOT read
    // as human confirmation.
    const secondScan = await gated.execute(
      { target: 'alpha' },
      ctx({ workspaceId: wsId, requestId: 'scan-req-2', origin: 'scan' })
    )

    expect(mutate).not.toHaveBeenCalled()
    expect((secondScan.data as { pending?: boolean }).pending).toBe(true)

    // A real inbound message (origin unset) DOES confirm the still-staged
    // proposal — the gate isn't broken, only scan-origin calls are barred
    // from supplying the confirming half.
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

    // Refinement: same request turn, different body — "add safe travels to it".
    const second = await gated.execute(
      { conversation_id: 'conv-1', body: 'Tell them Max will greet them at 11. Safe travels!' },
      ctx({ workspaceId: wsId, requestId: 'req-1' })
    )
    const secondId = (second.data as { pending_action_id: string }).pending_action_id

    expect(secondId).not.toBe(firstId)

    // The OLD row is cancelled and explicitly linked to the row that
    // superseded it — args/summary untouched, so the original draft is
    // still readable in the audit trail.
    const rows = (fakeSupabase as unknown as { __rows: Row[] }).__rows
    const oldRow = rows.find((r) => r.id === firstId)
    expect(oldRow?.cancelled_at).toBeTruthy()
    expect(oldRow?.superseded_by).toBe(secondId)
    expect(oldRow?.args).toEqual({ conversation_id: 'conv-1', body: 'Tell them Max will greet them at 11.' })

    // Confirming the NEW (superseding) id from a fresh request executes it.
    const confirmNew = await gated.execute(
      { conversation_id: 'conv-1', body: 'Tell them Max will greet them at 11. Safe travels!' },
      ctx({ workspaceId: wsId, requestId: 'req-2' })
    )
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(confirmNew).toEqual({ ok: true, data: { sent: true } })
  })

  it('does not supersede across different conversation_ids', async () => {
    const mutate = vi.fn<Tool<FakeSendArgs>['execute']>(async () => ({ ok: true, data: { sent: true } }))
    const gated = gateHighRisk(makeSendTool(mutate))
    const wsId = 'ws-supersede-2'

    await gated.execute(
      { conversation_id: 'conv-A', body: 'Message to A' },
      ctx({ workspaceId: wsId, requestId: 'req-1' })
    )
    await gated.execute(
      { conversation_id: 'conv-B', body: 'Message to B' },
      ctx({ workspaceId: wsId, requestId: 'req-1' })
    )

    // Both independently confirmable — B staging must not have cancelled A.
    const confirmA = await gated.execute(
      { conversation_id: 'conv-A', body: 'Message to A' },
      ctx({ workspaceId: wsId, requestId: 'req-2' })
    )
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(confirmA).toEqual({ ok: true, data: { sent: true } })

    const confirmB = await gated.execute(
      { conversation_id: 'conv-B', body: 'Message to B' },
      ctx({ workspaceId: wsId, requestId: 'req-3' })
    )
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(confirmB).toEqual({ ok: true, data: { sent: true } })
  })
})

describe('gateHighRisk — draft_in_inbox staged summary (2026-08-17 Pam Ott incident)', () => {
  // draft_in_inbox was raised from low-risk (immediate, no checkpoint) to
  // high-risk (staged + confirmed) after it silently filed a customer's
  // draft into the operator's own email instead of showing it in chat. This
  // locks in that the operator sees a clear, non-"sent" summary BEFORE
  // confirming — the whole point of the risk-tier change.
  function makeDraftInInboxTool(mutate: Tool<FakeSendArgs>['execute']): Tool<FakeSendArgs> {
    return {
      name: 'draft_in_inbox',
      description: 'test draft-in-inbox tool',
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

  it('stages with a summary that says NOT sent and shows the full body, without executing the real mutation', async () => {
    const mutate = vi.fn<Tool<FakeSendArgs>['execute']>(async () => ({ ok: true, data: { sent: false } }))
    const gated = gateHighRisk(makeDraftInInboxTool(mutate))

    const result = await gated.execute(
      { conversation_id: 'conv-pam', body: 'Dear Pam, thanks for your interest...' },
      ctx({ workspaceId: 'ws-draft-1', requestId: 'req-1' })
    )

    expect(mutate).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    const data = result.data as { pending: boolean; executed: boolean; summary: string }
    expect(data.pending).toBe(true)
    expect(data.executed).toBe(false)
    expect(data.summary).toMatch(/Not sent/)
    expect(data.summary).toContain('Dear Pam, thanks for your interest...')
  })

  it('confirms on a later, separate request — running the real mutation exactly once', async () => {
    const mutate = vi.fn<Tool<FakeSendArgs>['execute']>(async () => ({ ok: true, data: { sent: false, draft_id: 'd1' } }))
    const gated = gateHighRisk(makeDraftInInboxTool(mutate))
    const wsId = 'ws-draft-2'

    await gated.execute(
      { conversation_id: 'conv-pam', body: 'Dear Pam...' },
      ctx({ workspaceId: wsId, requestId: 'req-1' })
    )
    const confirmed = await gated.execute(
      { conversation_id: 'conv-pam', body: 'Dear Pam...' },
      ctx({ workspaceId: wsId, requestId: 'req-2' })
    )

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(confirmed).toEqual({ ok: true, data: { sent: false, draft_id: 'd1' } })
  })
})
