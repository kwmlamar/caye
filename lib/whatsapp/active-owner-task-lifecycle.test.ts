import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const { resolveOpenEscalations } = vi.hoisted(() => ({ resolveOpenEscalations: vi.fn(async () => {}) }))
vi.mock('@/lib/caye-agent/tools/write-low/resolve-open-escalations', () => ({ resolveOpenEscalations }))

import { markOwnerTaskHandled, type OwnerTaskCandidate } from './active-owner-task'

function fakeDb() {
  const calls: { table: string; update?: Record<string, unknown> }[] = []
  return {
    calls,
    client: {
      from(table: string) {
        const call: { table: string; update?: Record<string, unknown> } = { table }
        calls.push(call)
        const chain: Record<string, unknown> = {
          update(values: Record<string, unknown>) { call.update = values; return chain },
          eq() { return chain }, is() { return chain }, neq() { return chain }, select() { return chain },
          maybeSingle: async () => ({ data: { id: 'action-1' }, error: null }),
          then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: null, error: null }).then(resolve) },
        }
        return chain
      },
    } as never,
  }
}

const TASK: OwnerTaskCandidate = {
  id: 'action-1', workspaceId: 'ws-1', operatorId: 7, toolName: 'send_reply',
  summary: 'Send to Laney', conversationId: 'conv-laney', customerName: 'Laney',
  customerId: 'laney@example.com', createdAt: '2026-08-14T01:37:00Z',
  expiresAt: '2026-08-14T01:52:00Z', executedAt: null, cancelledAt: null,
  ownerHandledAt: null, droppedReportedAt: '2026-08-14T01:55:00Z',
}

describe('owner-handled lifecycle', () => {
  it('closes task/escalation/attention without changing expiry or sending', async () => {
    const db = fakeDb()
    const result = await markOwnerTaskHandled({
      supabase: db.client, task: TASK, operatorId: 7,
      note: 'operator completed externally', now: new Date('2026-08-14T01:56:39Z'),
    })
    expect(result).toEqual({ ok: true })
    const pending = db.calls.find((call) => call.table === 'caye_pending_actions')?.update
    expect(pending).toMatchObject({
      owner_handled_at: '2026-08-14T01:56:39.000Z',
      owner_handled_by_operator_id: 7,
      owner_handled_note: 'operator completed externally',
      cancelled_at: '2026-08-14T01:56:39.000Z',
    })
    expect(pending).not.toHaveProperty('expires_at')
    expect(pending).not.toHaveProperty('executed_at')
    expect(resolveOpenEscalations).toHaveBeenCalledWith(db.client, 'conv-laney')
    expect(db.calls.find((call) => call.table === 'unified_conversations')?.update).toMatchObject({ human_agent_enabled: false })
    expect(db.calls.find((call) => call.table === 'caye_owner_attention')?.update).toMatchObject({ status: 'resolved', blocked_on_operator: false })
  })
})
