/**
 * GET /api/founder/health
 *
 * Cross-workspace "is Caye alive" snapshot for the founder's "Health"
 * rail tab — a passive, read-only visualization over signals that
 * already exist and already alert independently (cron staleness,
 * migration drift): this route never sends an alert itself, it just
 * reads the same tables the watchdogs read. Built so the founder gets a
 * glance instead of having to ask Caye "how are the crons doing" in
 * Admin Shell every time (get_cron_health, lib/caye-agent/tools/admin/
 * read/get-cron-health.ts) — that tool only reports on CRON_JOBS (4
 * triggerable crons); this route uses MONITORED_CRONS instead (5 crons,
 * the actual list the stale-cron watchdog alerts on — includes
 * outbound-worker and eod-summary, which CRON_JOBS omits).
 *
 * Four signals, each a stand-in "organ" on the Health page:
 *  - cron health (MONITORED_CRONS × caye_cron_runs)
 *  - WhatsApp operator-ping deliverability (logic moved here from the
 *    now-deleted /api/founder/whatsapp-health route and
 *    WhatsAppHealthCard component — Health absorbs that surface rather
 *    than keeping a second place to check for the same failure)
 *  - DB migration drift (lib/db/migration-drift.ts's checkMigrationDrift,
 *    not the ...AndAlert variant — no side effects here)
 *  - LLM/agent activity — most recent llm_call_log row across all
 *    workspaces, as a coarse "is Caye's brain actually firing" check
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { MONITORED_CRONS } from '@/lib/cron-run-log'
import { checkMigrationDrift } from '@/lib/db/migration-drift'
import { OPERATOR_LOGGABLE_KINDS } from '@/app/api/caye/outbound-worker/route'

const WHATSAPP_LOOKBACK_HOURS = 48
const LLM_ACTIVITY_STALE_MINUTES = 30

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()

  const [
    { data: cronRows, error: cronErr },
    { data: waConfigs, error: waConfigErr },
    migrationDrift,
    { data: latestLlmRows, error: llmErr },
  ] = await Promise.all([
    supabase
      .from('caye_cron_runs')
      .select('cron_name, last_started_at, last_finished_at, last_status, last_error, last_duration_ms'),
    supabase
      .from('workspace_ai_config')
      .select('workspace_id, whatsapp_failure_streak, whatsapp_unreachable')
      .eq('whatsapp_outbound_enabled', true),
    checkMigrationDrift(),
    supabase
      .from('llm_call_log')
      .select('called_at')
      .order('called_at', { ascending: false })
      .limit(1),
  ])

  if (cronErr) return NextResponse.json({ error: cronErr.message }, { status: 500 })
  if (waConfigErr) return NextResponse.json({ error: waConfigErr.message }, { status: 500 })
  if (llmErr) return NextResponse.json({ error: llmErr.message }, { status: 500 })

  // ── Cron health ──
  const cronByName = new Map((cronRows ?? []).map((r) => [r.cron_name, r]))
  const now = Date.now()
  const crons = MONITORED_CRONS.map((expectation) => {
    const row = cronByName.get(expectation.cronName)
    const lastFinishedMs = row?.last_finished_at ? new Date(row.last_finished_at as string).getTime() : null
    const ageMinutes = lastFinishedMs ? (now - lastFinishedMs) / 60000 : Infinity
    const stale = ageMinutes > expectation.maxStalenessMinutes
    return {
      cron_name: expectation.cronName,
      label: expectation.label,
      last_started_at: row?.last_started_at ?? null,
      last_finished_at: row?.last_finished_at ?? null,
      last_status: row?.last_status ?? null,
      last_error: row?.last_error ?? null,
      last_duration_ms: row?.last_duration_ms ?? null,
      stale,
    }
  })
  const cronsHealthy = crons.every((c) => !c.stale && c.last_status !== 'error')

  // ── WhatsApp deliverability ──
  const waWorkspaceIds = (waConfigs ?? []).map((c) => c.workspace_id as string)
  const { data: customers } = waWorkspaceIds.length
    ? await supabase.from('customers').select('id, business_name').in('id', waWorkspaceIds)
    : { data: [] }
  const nameByWorkspace = new Map((customers ?? []).map((c) => [c.id as string, (c.business_name as string | null) ?? c.id as string]))

  const cutoff = new Date(Date.now() - WHATSAPP_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
  const { data: recentSends } = waWorkspaceIds.length
    ? await supabase
        .from('caye_outbound_queue')
        .select('workspace_id, wa_delivery_status, wa_delivery_status_at, kind')
        .eq('status', 'sent')
        .gte('sent_at', cutoff)
        .in('workspace_id', waWorkspaceIds)
        .in('kind', Array.from(OPERATOR_LOGGABLE_KINDS))
    : { data: [] }

  const whatsapp = (waConfigs ?? []).map((cfg) => {
    const workspaceId = cfg.workspace_id as string
    const sends = (recentSends ?? []).filter((r) => r.workspace_id === workspaceId)
    const confirmed = sends.filter((r) => r.wa_delivery_status === 'delivered' || r.wa_delivery_status === 'read')
    const lastConfirmedAt = confirmed
      .map((r) => r.wa_delivery_status_at as string | null)
      .filter((t): t is string => !!t)
      .sort()
      .at(-1) ?? null
    return {
      workspace_id: workspaceId,
      business_name: nameByWorkspace.get(workspaceId) ?? workspaceId,
      failure_streak: (cfg.whatsapp_failure_streak as number | null) ?? 0,
      unreachable: (cfg.whatsapp_unreachable as boolean | null) ?? false,
      last_confirmed_at: lastConfirmedAt,
      no_confirmed_deliveries: sends.length > 0 && confirmed.length === 0,
    }
  })
  const whatsappHealthy = whatsapp.every((w) => !w.unreachable && w.failure_streak === 0 && !w.no_confirmed_deliveries)

  // ── LLM activity ──
  const lastCallAt = latestLlmRows?.[0]?.called_at as string | undefined
  const lastCallAgeMinutes = lastCallAt ? (now - new Date(lastCallAt).getTime()) / 60000 : Infinity
  const llmActivity = {
    last_call_at: lastCallAt ?? null,
    stale: lastCallAgeMinutes > LLM_ACTIVITY_STALE_MINUTES,
  }

  return NextResponse.json({
    crons: { healthy: cronsHealthy, items: crons },
    whatsapp: { healthy: whatsappHealthy, items: whatsapp },
    migrations: { healthy: migrationDrift.ok, ...migrationDrift },
    llm_activity: { healthy: !llmActivity.stale, ...llmActivity },
  })
}
