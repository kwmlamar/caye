import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const d = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip

d('recordCronRun — live append-only history', () => {
  it('writes latest state and history through service-role access', async () => {
    const name = `history-verification-${Date.now()}`
    const { recordCronRun } = await import('./cron-run-log')
    const { createServiceClient } = await import('./supabase-server')
    const db = createServiceClient()
    try {
      await recordCronRun(name, async () => ({ verified: true }))
      const { data, error } = await db.from('caye_cron_run_history').select('status,summary').eq('cron_name', name).single()
      expect(error).toBeNull()
      expect(data).toMatchObject({ status: 'ok', summary: { verified: true } })
    } finally {
      await db.from('caye_cron_run_history').delete().eq('cron_name', name)
      await db.from('caye_cron_runs').delete().eq('cron_name', name)
    }
  })
})
