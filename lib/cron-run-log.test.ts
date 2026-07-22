import { describe, it, expect, vi } from 'vitest'
import { recordCronRun } from './cron-run-log'

vi.mock('server-only', () => ({}))

type Row = Record<string, unknown>

// Minimal fake supporting only what recordCronRun uses: from().upsert().
function makeFakeSupabase() {
  const rows = new Map<string, Row>()
  const client = {
    from(_table: string) {
      return {
        upsert(patch: Row, opts: { onConflict: string }) {
          return Promise.resolve().then(() => {
            const key = patch[opts.onConflict] as string
            const existing = rows.get(key) ?? {}
            rows.set(key, { ...existing, ...patch })
            return { data: rows.get(key), error: null }
          })
        },
      }
    },
    _rows: rows,
  }
  return client
}

const fakeSupabase = makeFakeSupabase()

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => fakeSupabase,
}))

describe('recordCronRun', () => {
  it('records a start row then an ok row on success', async () => {
    const result = await recordCronRun('test-cron-ok', async () => ({ processed: 3 }))

    expect(result).toEqual({ processed: 3 })
    const row = fakeSupabase._rows.get('test-cron-ok')
    expect(row?.last_status).toBe('ok')
    expect(row?.last_summary).toEqual({ processed: 3 })
    expect(row?.last_started_at).toBeDefined()
    expect(row?.last_finished_at).toBeDefined()
    expect(typeof row?.last_duration_ms).toBe('number')
    expect(row?.last_error).toBeNull()
  })

  it('records a start row then an error row on failure, and rethrows', async () => {
    await expect(
      recordCronRun('test-cron-fail', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    const row = fakeSupabase._rows.get('test-cron-fail')
    expect(row?.last_status).toBe('error')
    expect(row?.last_error).toBe('boom')
  })
})
