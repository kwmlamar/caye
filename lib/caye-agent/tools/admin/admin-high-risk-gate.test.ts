import { describe, it, expect, vi } from 'vitest'
import type { Tool, ToolContext } from '../types'
import { gateAdminHighRisk } from './admin-high-risk-gate'

vi.mock('server-only', () => ({}))
type Row = Record<string, unknown>
function makeFakeSupabase() {
  const rows: Row[] = []
  return { from(_table: string) { return {
    select(_cols: string) { const filters: Array<(row: Row) => boolean> = []; const builder = {
      eq(col: string, val: unknown) { filters.push((row) => row[col] === val); return builder },
      is(col: string, val: null) { filters.push((row) => (row[col] ?? null) === val); return builder },
      gt(col: string, val: string) { filters.push((row) => (row[col] as string) > val); return builder },
      order() { return builder }, limit() { return builder },
      async maybeSingle() { const matches = rows.filter((r) => filters.every((f) => f(r))); return { data: matches[matches.length - 1] ?? null, error: null } },
    }; return builder },
    insert(row: Row) { return Promise.resolve().then(() => { const full = { id: `row_${rows.length}`, ...row }; rows.push(full); return { data: full, error: null } }) },
    update(patch: Row) { return { eq(col: string, val: unknown) { const row = rows.find((r) => r[col] === val); if (row) Object.assign(row, patch); return Promise.resolve({ data: row ?? null, error: null }) } } },
  } } }
}
const fakeSupabase = makeFakeSupabase()
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => fakeSupabase }))
interface FakeArgs { cron_name: string }
function makeRealTool(mutate: Tool<FakeArgs>['execute']): Tool<FakeArgs> { return { name: 'trigger_cron', description: 'test tool', risk: 'high', roles: ['founder'], modes: ['admin-shell'], inputSchema: { type: 'object', properties: { cron_name: { type: 'string' } }, required: ['cron_name'] }, execute: mutate } }
function ctx(requestId: string): ToolContext { return { workspaceId: '00000000-0000-0000-0000-000000000000', callerRole: 'founder', operatorId: null, requestId } }

describe('gateAdminHighRisk', () => {
  it('still stages unrelated cron actions', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { ran: true } }))
    const result = await gateAdminHighRisk(makeRealTool(mutate)).execute({ cron_name: 'test-alpha' }, ctx('req-1'))
    expect(mutate).not.toHaveBeenCalled(); expect((result.data as { pending?: boolean }).pending).toBe(true)
  })
  it.each(['job-search-sourcing', 'job-search-prepare'])('runs safe founder job operation %s immediately', async (cronName) => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { ran: true } }))
    const result = await gateAdminHighRisk(makeRealTool(mutate)).execute({ cron_name: cronName }, ctx(`req-${cronName}`))
    expect(mutate).toHaveBeenCalledTimes(1); expect(result).toEqual({ ok: true, data: { ran: true } })
  })
  it('keeps real application-affecting crons behind confirmation by default', async () => {
    const mutate = vi.fn<Tool<FakeArgs>['execute']>(async () => ({ ok: true, data: { ran: true } }))
    const gated = gateAdminHighRisk(makeRealTool(mutate))
    await gated.execute({ cron_name: 'job-search-submit' }, ctx('req-submit-1'))
    expect(mutate).not.toHaveBeenCalled()
  })
})
