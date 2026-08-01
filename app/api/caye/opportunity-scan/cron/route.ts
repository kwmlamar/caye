/**
 * GET /api/caye/opportunity-scan/cron
 *
 * Hourly cron — for each workspace with opportunity_scan_enabled=true, at a
 * small fixed set of local-hour slots, runs a real back-office agent turn
 * (not a fixed heuristic) with a system-authored prompt telling Caye to
 * review the workspace like an employee doing rounds. She reasons over her
 * own read tools and decides what, if anything, needs surfacing.
 *
 * Safety model: Caye may act directly on low-risk tools (they already
 * execute ungated, same as in chat). Anything high-risk goes through the
 * existing gateHighRisk confirmation flow — staged, never auto-executed —
 * with one added guard: ctx.origin: 'scan' means THIS invocation can never
 * supply the confirming half of that flow, even if a later scan proposes
 * the identical tool+args again. Only a real inbound message from the
 * operator (origin unset) can confirm. See lib/caye-agent/tools/high-risk-
 * gate.ts for the structural argument.
 *
 * Per-workspace "what did I already flag" state lives on
 * workspace_ai_config (last_opportunity_scan_at/_summary) — NOT on
 * caye_cron_runs, which is a single global row per cron_name and the
 * wrong shape for per-workspace history. The whole tick is still wrapped
 * in recordCronRun('opportunity-scan', ...) for the global health-check
 * row MONITORED_CRONS reads, same as every other cron.
 *
 * Authenticated via CRON_SECRET, same dual-header contract as the other
 * cron routes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { cayeAgent } from '@/lib/caye-agent'
import { sendFreeFormWhatsApp, deliveryFieldsFromResult } from '@/lib/whatsapp/outbound'
import { isWhatsAppWindowOpen } from '@/lib/whatsapp/window'
import { loadScheduleConfig, inQuietHours, type WorkspaceScheduleConfig } from '@/lib/whatsapp/schedule'
import { resolveOperatorByPhone } from '@/lib/operator-identity'
import { persistAgentTurns } from '@/lib/caye-operator-messages'
import { recordCronRun } from '@/lib/cron-run-log'

// Three passes a day, spread through waking hours — bounds LLM spend to a
// handful of tool-loop invocations per workspace per day and avoids
// feeling spammy. Not the digest's 7am slot on purpose (different job).
const TARGET_LOCAL_HOURS = [10, 14, 18]

// Cap what we persist into the "last scan" column — this is prompt
// context for the next run, not a full transcript.
const MAX_SUMMARY_CHARS = 2000

interface WorkspaceRow {
  workspace_id: string
  operator_whatsapp_number: string | null
  last_opportunity_scan_at: string | null
  last_opportunity_scan_summary: string | null
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    return NextResponse.json(await runOpportunityScan())
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

/** Extracted from GET so Admin Shell's trigger_cron can run this on demand
 *  (lib/caye-agent/tools/admin/cron-registry.ts) without going back through
 *  HTTP + CRON_SECRET. Same recordCronRun wrapper either way, so a manual
 *  run updates the health row exactly like a scheduled one. */
export async function runOpportunityScan() {
  return recordCronRun('opportunity-scan', async () => {
    const supabase = createServiceClient()
    const now = new Date()

    const { data: rows, error } = await supabase
      .from('workspace_ai_config')
      .select(
        'workspace_id, operator_whatsapp_number, last_opportunity_scan_at, last_opportunity_scan_summary'
      )
      .eq('opportunity_scan_enabled', true)
      .not('operator_whatsapp_number', 'is', null)
      .eq('whatsapp_outbound_enabled', true)

    if (error) throw new Error(error.message)

    const results: Array<{ workspace_id: string; status: string; detail?: string }> = []

    for (const row of (rows ?? []) as unknown as WorkspaceRow[]) {
      try {
        const result = await processWorkspace(supabase, row, now)
        results.push({ workspace_id: row.workspace_id, ...result })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[opportunity-scan] workspace ${row.workspace_id}:`, msg)
        results.push({ workspace_id: row.workspace_id, status: 'error', detail: msg })
      }
    }

    return { checked: results.length, results }
  })
}

async function processWorkspace(
  supabase: ReturnType<typeof createServiceClient>,
  row: WorkspaceRow,
  now: Date
): Promise<{ status: string; detail?: string }> {
  if (!row.operator_whatsapp_number) return { status: 'skip', detail: 'no operator phone' }

  const cfg = await loadScheduleConfig(row.workspace_id)
  const skip = shouldSkip({ now, cfg, lastScanAtISO: row.last_opportunity_scan_at })
  if (skip) return { status: 'skip', detail: skip }

  const operator = await resolveOperatorByPhone(supabase, row.workspace_id, row.operator_whatsapp_number)
  if (!operator) return { status: 'skip', detail: 'no operator_allowlist match for operator phone' }

  const prompt = buildScanPrompt(row.last_opportunity_scan_summary)

  const agentResult = await cayeAgent({
    mode: 'back-office',
    workspaceId: row.workspace_id,
    userMessage: prompt,
    callerRole: 'founder',
    operatorId: operator.id,
    origin: 'scan',
  })

  const summaryText = agentResult.replyText || '(Nothing needed attention this scan.)'
  await supabase
    .from('workspace_ai_config')
    .update({
      last_opportunity_scan_at: now.toISOString(),
      last_opportunity_scan_summary: summaryText.slice(0, MAX_SUMMARY_CHARS),
    })
    .eq('workspace_id', row.workspace_id)

  if (!agentResult.replyText) {
    return { status: 'ok', detail: 'nothing to report' }
  }

  const windowOpen = await isWhatsAppWindowOpen(row.workspace_id, row.operator_whatsapp_number)
  if (!windowOpen) {
    // Don't hard-fail — the pending action (if any) and the persisted
    // turns still exist and will surface next time the owner opens a
    // real conversation with Caye.
    await persistAgentTurns(supabase, row.workspace_id, agentResult.newTurns, operator)
    return { status: 'skipped_window_closed' }
  }

  const sendResult = await sendFreeFormWhatsApp(
    row.operator_whatsapp_number,
    agentResult.replyText,
    `opportunity-scan-${row.workspace_id}-${now.getTime()}`
  )
  if (sendResult.status === 'failed') {
    console.error(`[opportunity-scan] send failed for ${row.workspace_id}:`, sendResult.error)
  }

  await persistAgentTurns(supabase, row.workspace_id, agentResult.newTurns, operator, sendResult)

  return sendResult.status === 'failed'
    ? { status: 'send_failed', detail: sendResult.error }
    : { status: 'sent' }
}

function buildScanPrompt(lastSummary: string | null): string {
  const lastSummaryBlock = lastSummary
    ? `\n\nWhat you flagged or proposed last scan, for reference (don't repeat it unless the situation has clearly escalated):\n${lastSummary}`
    : ''

  return (
    "This is your periodic self-initiated workspace scan, not a message from the operator. " +
    'Review current state using your read tools (held queue, calendar, revenue, pending quotes, ' +
    'recent activity) and decide if anything needs attention, the way a good employee doing rounds ' +
    'would. You may act directly using your low-risk tools. For anything needing a high-risk action, ' +
    'propose it via the normal tool — it will stage for the owner\'s approval, not execute directly. ' +
    "Only surface things that are new or materially worse since your last scan; don't repeat what " +
    'you already flagged unless it has escalated. If nothing needs surfacing, say so briefly. ' +
    'Every action you take and every proposal you make must state your reasoning — what you ' +
    "observed, why it matters, what you recommend and why — never just the bare action. Bad: " +
    "'Cancel hold #421?' Good: 'Hold #421 has been inactive 72h, two reminders went unanswered, " +
    "and it expires in 3h — recommend releasing it.'" +
    lastSummaryBlock
  )
}

function shouldSkip(args: {
  now: Date
  cfg: WorkspaceScheduleConfig
  lastScanAtISO: string | null
}): string | null {
  const { now, cfg } = args
  if (cfg.mutedUntil && cfg.mutedUntil > now) return 'muted'
  if (inQuietHours(now, cfg)) return 'quiet_hours'

  const hour = localHour(now, cfg.timezone)
  if (!TARGET_LOCAL_HOURS.includes(hour)) {
    return `not a scan hour (now=${hour}, targets=${TARGET_LOCAL_HOURS.join(',')})`
  }

  if (args.lastScanAtISO) {
    const last = new Date(args.lastScanAtISO)
    if (!Number.isNaN(last.getTime()) && localHourKey(last, cfg.timezone) === localHourKey(now, cfg.timezone)) {
      return 'already scanned this hour'
    }
  }
  return null
}

function localHour(date: Date, tz: string): number {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
    const h = parseInt(f.format(date), 10)
    return h === 24 ? 0 : h
  } catch {
    return date.getUTCHours()
  }
}

/** Local YYYY-MM-DD-HH — used to dedupe "already scanned this hour block". */
function localHourKey(date: Date, tz: string): string {
  try {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    })
    return f.format(date)
  } catch {
    return date.toISOString().slice(0, 13)
  }
}
