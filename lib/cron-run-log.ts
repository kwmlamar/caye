import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Wraps a cron job's core logic so every invocation — the scheduled
 * cron-job.org hit AND a founder-triggered manual run from Admin Shell
 * (lib/caye-agent/tools/admin/write-high/trigger-cron.ts) — updates
 * caye_cron_runs. Deliberately lives at the function level (wrapping
 * runMorningDigest/runEscalationFollowup/runGmailPoll directly) rather
 * than in the admin-shell tool, so "last run" reflects reality regardless
 * of which caller triggered it.
 *
 * Last-run-wins only — no history/audit trail. If a run history is ever
 * wanted, that's an append-only log table, a separate decision.
 */
export async function recordCronRun<T extends Record<string, unknown>>(
  cronName: string,
  fn: () => Promise<T>
): Promise<T> {
  const supabase = createServiceClient()
  const startedAt = new Date()

  await supabase
    .from('caye_cron_runs')
    .upsert(
      { cron_name: cronName, last_started_at: startedAt.toISOString() },
      { onConflict: 'cron_name' }
    )

  try {
    const result = await fn()
    await supabase
      .from('caye_cron_runs')
      .upsert(
        {
          cron_name: cronName,
          last_finished_at: new Date().toISOString(),
          last_status: 'ok',
          last_summary: result,
          last_error: null,
          last_duration_ms: Date.now() - startedAt.getTime(),
        },
        { onConflict: 'cron_name' }
      )
    return result
  } catch (err) {
    await supabase
      .from('caye_cron_runs')
      .upsert(
        {
          cron_name: cronName,
          last_finished_at: new Date().toISOString(),
          last_status: 'error',
          last_error: err instanceof Error ? err.message : String(err),
          last_duration_ms: Date.now() - startedAt.getTime(),
        },
        { onConflict: 'cron_name' }
      )
    throw err
  }
}
