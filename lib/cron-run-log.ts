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

// ---------------------------------------------------------------------------
// Stale-cron alerting — a dead-man's-switch on top of caye_cron_runs.
//
// Built after discovering (2026-07-25) that /api/caye/outbound-worker went
// ~25h without a single cron-job.org hit, and separately that
// /api/caye/morning-digest had *never* run — neither surfaced anywhere
// until an operator (Karenda/Bimini) reported missing WhatsApp messages.
// caye_cron_runs already tracked last-run state (built for the founder's
// on-demand get_cron_health admin-shell tool); this just adds a push check
// on top so a stalled job doesn't sit silent for days before someone
// thinks to ask.
//
// Deliberately NOT its own cron (chicken-and-egg — the thing checking for
// stalled crons could itself stall). Instead called opportunistically from
// two independent, differently-scheduled crons (outbound-worker: ~1min,
// escalation-followup: hourly) so one going dark doesn't blind the check.
// ---------------------------------------------------------------------------

export interface CronExpectation {
  cronName: string
  label: string
  maxStalenessMinutes: number
}

export const MONITORED_CRONS: CronExpectation[] = [
  { cronName: 'outbound-worker', label: 'Outbound worker', maxStalenessMinutes: 10 },
  { cronName: 'morning-digest', label: 'Morning digest', maxStalenessMinutes: 150 },
  { cronName: 'escalation-followup', label: 'Escalation follow-up', maxStalenessMinutes: 150 },
  { cronName: 'eod-summary', label: 'EOD summary', maxStalenessMinutes: 150 },
  // Added once registered on cron-job.org (2026-07-28) — omitted before
  // that so an unregistered job didn't alert as "never run" before anyone
  // had a chance to set it up.
  { cronName: 'template-sync', label: 'WhatsApp template sync', maxStalenessMinutes: 150 },
  // Opportunity Scan + Business Insights (2026-07-28). Hourly tick /
  // weekly tick respectively — staleness thresholds sized to each cron's
  // own cadence, not copy-pasted from the hourly crons above.
  { cronName: 'opportunity-scan', label: 'Opportunity scan', maxStalenessMinutes: 150 },
  // 12600 = 8.75 days — pads a week-cadence job so ordinary tick jitter
  // doesn't false-positive right at the 7-day boundary.
  { cronName: 'business-insights', label: 'Business insights', maxStalenessMinutes: 12600 },
]

// Once alerted, don't re-alert for the same stall for 4h — a stuck
// cron-job.org registration doesn't need a fresh ping every minute.
const ALERT_COOLDOWN_MINUTES = 240

interface CronRunRow {
  cron_name: string
  last_finished_at: string | null
  last_stale_alert_at: string | null
}

/**
 * Best-effort — never throws. Call fire-and-forget from a frequently-run
 * cron; a failure here must never break the cron that called it.
 */
export async function checkStaleCronsAndAlert(): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { data: rows } = await supabase
      .from('caye_cron_runs')
      .select('cron_name, last_finished_at, last_stale_alert_at')

    const byName = new Map((rows ?? []).map((r) => [r.cron_name, r as CronRunRow]))
    const now = Date.now()
    const staleLabels: string[] = []
    const toMarkAlerted: string[] = []

    for (const cron of MONITORED_CRONS) {
      const row = byName.get(cron.cronName)
      const lastFinishedMs = row?.last_finished_at ? new Date(row.last_finished_at).getTime() : null
      const ageMinutes = lastFinishedMs ? (now - lastFinishedMs) / 60000 : Infinity
      if (ageMinutes <= cron.maxStalenessMinutes) continue

      staleLabels.push(
        `${cron.label} (${lastFinishedMs ? `${Math.round(ageMinutes / 60)}h since last run` : 'never run'})`
      )

      const lastAlertMs = row?.last_stale_alert_at ? new Date(row.last_stale_alert_at).getTime() : null
      const cooledDown = !lastAlertMs || (now - lastAlertMs) / 60000 > ALERT_COOLDOWN_MINUTES
      if (cooledDown) toMarkAlerted.push(cron.cronName)
    }

    if (toMarkAlerted.length === 0) return

    await alertFounderOfStaleCrons(staleLabels)

    await supabase.from('caye_cron_runs').upsert(
      toMarkAlerted.map((cronName) => ({
        cron_name: cronName,
        last_stale_alert_at: new Date().toISOString(),
      })),
      { onConflict: 'cron_name' }
    )
  } catch (err) {
    console.error('[cron-run-log] stale-check failed:', err)
  }
}

async function alertFounderOfStaleCrons(staleLabels: string[]): Promise<void> {
  const supabase = createServiceClient()
  const { data: setting } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'founder_phone')
    .maybeSingle()

  const founderPhone = setting?.value as string | undefined
  if (!founderPhone) {
    console.error('[cron-run-log] stale crons detected but no founder_phone configured:', staleLabels)
    return
  }

  const { sendFreeFormWhatsApp } = await import('@/lib/whatsapp/outbound')
  const result = await sendFreeFormWhatsApp(
    founderPhone,
    `⚠️ Cron health: ${staleLabels.join('; ')} — check cron-job.org.`,
    `cron-stale-alert-${Math.floor(Date.now() / (ALERT_COOLDOWN_MINUTES * 60 * 1000))}`
  )
  if (result.status === 'failed') {
    console.error('[cron-run-log] stale-cron founder alert send failed:', result.error)
  }
}
