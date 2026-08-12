import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('server-only', () => ({}))

interface Row {
  workspace_id: string
  first_touch_sent_at: string | null
  last_nudge_at: string | null
}

// Minimal fake supporting exactly the query shape countSentToday issues:
// from(table).select(col, {count:'exact',head:true}).eq(col,val).gte(col,val)
function makeFakeSupabase(rows: Row[]) {
  return {
    from(_table: string) {
      let filtered = rows
      const builder = {
        select(_cols: string, _opts?: unknown) { return builder },
        eq(col: keyof Row, val: unknown) {
          filtered = filtered.filter((r) => r[col] === val)
          return builder
        },
        gte(col: keyof Row, val: string) {
          filtered = filtered.filter((r) => {
            const v = r[col]
            return typeof v === 'string' && v >= val
          })
          return builder
        },
        then(resolve: (v: { count: number; data: Row[]; error: null }) => void) {
          resolve({ count: filtered.length, data: filtered, error: null })
        },
      }
      return builder
    },
  }
}

let fakeSupabase: ReturnType<typeof makeFakeSupabase>

vi.mock('./supabase-server', () => ({
  createServiceClient: () => fakeSupabase,
}))

const { countSentToday, underDailyCap, OUTREACH_DAILY_SEND_CAP } = await import('./outreach-send-limits')

describe('countSentToday / underDailyCap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T15:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts today\'s first-touch sends and follow-up sends together', async () => {
    fakeSupabase = makeFakeSupabase([
      { workspace_id: 'ws1', first_touch_sent_at: '2026-08-12T09:00:00Z', last_nudge_at: null },
      { workspace_id: 'ws1', first_touch_sent_at: null, last_nudge_at: '2026-08-12T10:00:00Z' },
      // Yesterday — shouldn't count.
      { workspace_id: 'ws1', first_touch_sent_at: '2026-08-11T23:00:00Z', last_nudge_at: null },
    ])
    expect(await countSentToday('ws1')).toBe(2)
  })

  it('ignores rows from a different workspace', async () => {
    fakeSupabase = makeFakeSupabase([
      { workspace_id: 'ws1', first_touch_sent_at: '2026-08-12T09:00:00Z', last_nudge_at: null },
      { workspace_id: 'ws2', first_touch_sent_at: '2026-08-12T09:00:00Z', last_nudge_at: null },
    ])
    expect(await countSentToday('ws1')).toBe(1)
  })

  it('returns 0 with no sends today', async () => {
    fakeSupabase = makeFakeSupabase([])
    expect(await countSentToday('ws1')).toBe(0)
  })

  it('underDailyCap is true below the cap and false at/above it', async () => {
    const rows: Row[] = Array.from({ length: OUTREACH_DAILY_SEND_CAP - 1 }, () => ({
      workspace_id: 'ws1',
      first_touch_sent_at: '2026-08-12T09:00:00Z',
      last_nudge_at: null,
    }))
    fakeSupabase = makeFakeSupabase(rows)
    expect(await underDailyCap('ws1')).toBe(true)

    fakeSupabase = makeFakeSupabase([
      ...rows,
      { workspace_id: 'ws1', first_touch_sent_at: '2026-08-12T09:00:00Z', last_nudge_at: null },
    ])
    expect(await underDailyCap('ws1')).toBe(false)
  })
})
