import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../types'

vi.mock('server-only', () => ({}))

const releaseConversationExecution = vi.fn(async () => undefined)
vi.mock('@/lib/conversation-execution', () => ({ releaseConversationExecution }))

interface Row {
  id: string
  workspace_id: string
  operator_id: number | null
  executed_at: string | null
  cancelled_at: string | null
  execution_claim_id: string | null
}

let row: Row | null = null
let updatedPatch: Record<string, unknown> | null = null

class Query {
  action: 'select' | 'update' = 'select'
  filters: Array<[string, unknown]> = []
  payload: Record<string, unknown> | null = null

  select() { return this }
  eq(column: string, value: unknown) { this.filters.push([column, value]); return this }
  is(column: string, value: unknown) { this.filters.push([column, value]); return this }
  update(patch: Record<string, unknown>) { this.action = 'update'; this.payload = patch; return this }

  private matches() {
    if (!row) return false
    return this.filters.every(([column, value]) => (row as Row)[column as keyof Row] === value)
  }

  async maybeSingle() {
    return { data: this.matches() ? row : null, error: null }
  }

  then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
    return this.execute().then(resolve, reject)
  }

  private async execute() {
    if (this.action === 'update' && this.matches()) {
      updatedPatch = this.payload
      Object.assign(row as Row, this.payload)
    }
    return { error: null }
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'caye_pending_actions') throw new Error(`unexpected table: ${table}`)
      return new Query()
    },
  }),
}))

const { rejectPendingAction } = await import('./reject-pending-action')

const ctx = { workspaceId: 'ws-1', callerRole: 'owner', operatorId: null, requestId: 'req-1' } as unknown as ToolContext

beforeEach(() => {
  row = {
    id: 'pa-1',
    workspace_id: 'ws-1',
    operator_id: null,
    executed_at: null,
    cancelled_at: null,
    execution_claim_id: null,
  }
  updatedPatch = null
  releaseConversationExecution.mockClear()
})

describe('reject_pending_action', () => {
  it('declines a staged action and records the reason', async () => {
    const res = await rejectPendingAction.execute({ pending_action_id: 'pa-1', reason: 'not our payment' }, ctx)
    expect(res.ok).toBe(true)
    expect(updatedPatch).toMatchObject({ cancellation_reason: 'not our payment' })
    expect(row?.cancelled_at).not.toBeNull()
  })

  it('records a null reason when none is given', async () => {
    const res = await rejectPendingAction.execute({ pending_action_id: 'pa-1' }, ctx)
    expect(res.ok).toBe(true)
    expect(updatedPatch).toMatchObject({ cancellation_reason: null })
  })

  it('refuses to decline an already-executed action', async () => {
    row!.executed_at = '2026-09-01T00:00:00.000Z'
    const res = await rejectPendingAction.execute({ pending_action_id: 'pa-1' }, ctx)
    expect(res.ok).toBe(false)
    expect(updatedPatch).toBeNull()
  })

  it('is idempotent on an already-cancelled action', async () => {
    row!.cancelled_at = '2026-09-01T00:00:00.000Z'
    const res = await rejectPendingAction.execute({ pending_action_id: 'pa-1' }, ctx)
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ already_cancelled: true })
    expect(updatedPatch).toBeNull()
  })

  it('errors cleanly when no staged action exists with that id', async () => {
    row = null
    const res = await rejectPendingAction.execute({ pending_action_id: 'missing' }, ctx)
    expect(res.ok).toBe(false)
  })

  it('releases the execution claim when one is present', async () => {
    row!.execution_claim_id = 'claim-1'
    await rejectPendingAction.execute({ pending_action_id: 'pa-1' }, ctx)
    expect(releaseConversationExecution).toHaveBeenCalledWith('claim-1')
  })
})
