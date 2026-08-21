import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tool, ToolContext } from '../types'

vi.mock('server-only', () => ({}))

type Row = Record<string, unknown>
const rows: Row[] = []
let conversationIsCurrent = true

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
vi.mock('../write-low/_guards', () => ({
  assertConversationOwnedByWorkspace: vi.fn(async () =>
    conversationIsCurrent
      ? { ok: true }
      : { ok: false, error: 'Conversation stale-conv not found in this workspace' }
  ),
}))

const ran: unknown[] = []
const targetTool: Tool<{ body: string; conversation_id: string }> = {
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
vi.mock('../external-draft-intent', () => ({ verifyExternalDraftIntent: vi.fn(async () => null) }))

import { confirmPendingAction } from './confirm-pending-action'

const FUTURE = () => new Date(Date.now() + 10 * 60 * 1000).toISOString()

function stage(overrides: Row = {}) {
  const id = `pa-${rows.length + 1}`
  rows.push({
    id,
    workspace_id: 'ws-1',
    operator_id: 20,
    tool_name: 'send_reply',
    args: { body: 'Send this exact body', conversation_id: 'conv-1' },
    summary: 'Send to Christina (email): Send this exact body',
    created_in_request_id: 'req-staged',
    expires_at: FUTURE(),
    executed_at: null,
    cancelled_at: null,
    superseded_by: null,
    ...overrides,
  })
  return id
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: 'ws-1',
    callerRole: 'owner',
    operatorId: 20,
    requestId: 'req-confirming',
    ...overrides,
  } as ToolContext
}

beforeEach(() => {
  rows.length = 0
  ran.length = 0
  conversationIsCurrent = true
})

describe('confirm_pending_action', () => {
  it('executes the exact staged args once for a current conversation', async () => {
    const id = stage()
    const result = await confirmPendingAction.execute({ pending_action_id: id }, ctx())
    expect(result.ok).toBe(true)
    expect(ran).toEqual([{ body: 'Send this exact body', conversation_id: 'conv-1' }])
    expect(rows[0].executed_at).toBeTruthy()
  })

  it('rejects stale conversation identity BEFORE claiming/executing the row', async () => {
    conversationIsCurrent = false
    const id = stage({ args: { body: 'Do not send', conversation_id: 'stale-conv' } })
    const result = await confirmPendingAction.execute({ pending_action_id: id }, ctx())
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error_code : null).toBe('STALE_CONVERSATION_IDENTITY')
    expect(ran).toHaveLength(0)
    expect(rows[0].executed_at).toBeNull()
  })

  it('rejects a superseded draft', async () => {
    const id = stage({ cancelled_at: new Date().toISOString(), superseded_by: 'pa-new' })
    const result = await confirmPendingAction.execute({ pending_action_id: id }, ctx())
    expect(result.ok).toBe(false)
    expect(ran).toHaveLength(0)
  })

  it('does not confirm in the same request that staged the action', async () => {
    const id = stage({ created_in_request_id: 'req-confirming' })
    expect((await confirmPendingAction.execute({ pending_action_id: id }, ctx())).ok).toBe(false)
    expect(ran).toHaveLength(0)
  })

  it('does not replay an executed action', async () => {
    const id = stage()
    await confirmPendingAction.execute({ pending_action_id: id }, ctx())
    expect((await confirmPendingAction.execute({ pending_action_id: id }, ctx())).ok).toBe(false)
    expect(ran).toHaveLength(1)
  })

  it('does not allow a different operator or workspace to confirm', async () => {
    const id = stage()
    expect(
      (await confirmPendingAction.execute({ pending_action_id: id }, ctx({ operatorId: 99 }))).ok
    ).toBe(false)
    expect(
      (await confirmPendingAction.execute({ pending_action_id: id }, ctx({ workspaceId: 'ws-2' }))).ok
    ).toBe(false)
    expect(ran).toHaveLength(0)
  })
})
