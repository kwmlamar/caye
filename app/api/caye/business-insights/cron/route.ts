/**
 * GET /api/caye/business-insights/cron
 *
 * Weekly cron — for each workspace with business_insights_enabled=true,
 * once a week runs a back-office agent turn asking Caye to notice
 * patterns over time (booking trends, best/worst-performing tours, repeat
 * customers) rather than point-in-time operational state.
 *
 * Deliberately a separate, lower-risk capability from opportunity-scan:
 * this is pure observation — no action is ever expected, so there's
 * nothing to gate. ctx.origin: 'scan' is still set (see the comment on
 * ToolContext.origin) purely as defense in depth, not because this path
 * is expected to call a high-risk tool.
 *
 * Scope is intentionally limited to what get_tour_type_performance and
 * get_revenue can actually support — booking volume/revenue by tour type,
 * trend vs. prior period, repeat-customer count. No per-channel response
 * time or inquiry-to-booking funnel: that tracking doesn't exist in the
 * schema yet, and the prompt is told not to invent it.
 *
 * Authenticated via CRON_SECRET, same dual-header contract as the other
 * cron routes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { cayeAgent } from '@/lib/caye-agent'
import { enqueueOutbound } from '@/lib/whatsapp/outbound'
import { loadScheduleConfig, inQuietHours, localDayOfWeek, type WorkspaceScheduleConfig } from '@/lib/whatsapp/schedule'
import { resolveOperatorByPhone } from '@/lib/operator-identity'
import { persistAgentTurns } from '@/lib/caye-operator-messages'
import { recordCronRun } from '@/lib/cron-run-log'
import { decideOperatorNotification } from '@/lib/whatsapp/operator-notification-gate'
import { markAttentionPending } from '@/lib/owner-attention'

// Monday 9am local — once a week, well clear of the daily digest/EOD noise.
const TARGET_WEEKDAY = 1
const TARGET_LOCAL_HOUR = 9
// Guards against re-sending if the cron fires more than once in the
// target hour, without requiring exact ISO-week bookkeeping.
const MIN_GAP_DAYS = 6

const INSIGHTS_PROMPT =
  "This is your periodic self-initiated business-insights review, not a message from the operator. " +
  'Look at booking and revenue patterns over the recent weeks using get_tour_type_performance and ' +
  'get_revenue — which tours are performing better or worse, how revenue is trending, whether repeat ' +
  "customers are showing up. This is observation only: don't take any action and don't propose one, " +
  "just report what you're noticing and why it matters, the way a good operations manager would in a " +
  "weekly note. Only use data you can actually see — don't invent response-time or conversion-funnel " +
  "numbers you don't have tools for. If nothing meaningful stands out yet (e.g. too little history), " +
  'say so briefly rather than padding the message.'

interface WorkspaceRow {
  workspace_id: string
  operator_whatsapp_number: string | null
  last_business_insights_sent_at: string | null
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
    return NextResponse.json(await runBusinessInsights())
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

/** Extracted from GET so Admin Shell's trigger_cron can run this on demand
 *  (lib/caye-agent/tools/admin/cron-registry.ts) without going back through
 *  HTTP + CRON_SECRET. Same recordCronRun wrapper either way, so a manual
 *  run updates the health row exactly like a scheduled one.
 *
 *  opts.force (2026-08-01, admin-shell manual trigger only): bypasses the
 *  Monday-9am/MIN_GAP_DAYS cadence gate, not muted/quiet_hours — see the
 *  matching comment on runOpportunityScan for why those stay enforced. */
export async function runBusinessInsights(opts?: { force?: boolean }) {
  return recordCronRun('business-insights', async () => {
    const supabase = createServiceClient()
    const now = new Date()

    const { data: rows, error } = await supabase
      .from('workspace_ai_config')
      .select('workspace_id, operator_whatsapp_number, last_business_insights_sent_at')
      .eq('business_insights_enabled', true)
      .not('operator_whatsapp_number', 'is', null)
      .eq('whatsapp_outbound_enabled', true)

    if (error) throw new Error(error.message)

    const results: Array<{ workspace_id: string; status: string; detail?: string }> = []

    for (const row of (rows ?? []) as unknown as WorkspaceRow[]) {
      try {
        const result = await processWorkspace(supabase, row, now, opts?.force ?? false)
        results.push({ workspace_id: row.workspace_id, ...result })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[business-insights] workspace ${row.workspace_id}:`, msg)
        results.push({ workspace_id: row.workspace_id, status: 'error', detail: msg })
      }
    }

    return { checked: results.length, results }
  })
}

async function processWorkspace(
  supabase: ReturnType<typeof createServiceClient>,
  row: WorkspaceRow,
  now: Date,
  force = false
): Promise<{ status: string; detail?: string }> {
  if (!row.operator_whatsapp_number) return { status: 'skip', detail: 'no operator phone' }

  const cfg = await loadScheduleConfig(row.workspace_id)
  const skip = shouldSkip({ now, cfg, lastSentAtISO: row.last_business_insights_sent_at, force })
  if (skip) return { status: 'skip', detail: skip }

  const operator = await resolveOperatorByPhone(supabase, row.workspace_id, row.operator_whatsapp_number)
  if (!operator) return { status: 'skip', detail: 'no operator_allowlist match for operator phone' }

  // Caller identity must match the recipient — see the same note in
  // opportunity-scan/cron. 'founder' here produced insights written about
  // the owner and then delivered to her (2026-08-06).
  const agentResult = await cayeAgent({
    mode: 'back-office',
    workspaceId: row.workspace_id,
    userMessage: INSIGHTS_PROMPT,
    callerRole: operator.role,
    callerName: operator.name,
    operatorId: operator.id,
    origin: 'scan',
  })

  if (!agentResult.replyText) {
    // Still counts as "ran" — update the marker so we don't retry every
    // hourly tick until next Monday.
    await supabase
      .from('workspace_ai_config')
      .update({ last_business_insights_sent_at: now.toISOString() })
      .eq('workspace_id', row.workspace_id)
    return { status: 'ok', detail: 'nothing to report' }
  }

  // Same gate as opportunity-scan: does the operator need to know something
  // NEW, not "did the weekly job run." Content-hash subject key — genuinely
  // different week-over-week numbers naturally register as a new item;
  // a same-week re-run with identical text collapses onto it instead of
  // re-pinging (MIN_GAP_DAYS above already makes this rare, but the gate
  // is the actual backstop, not the timing heuristic).
  const normalizedInsight = agentResult.replyText.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400)
  const subjectId = createHash('sha256').update(normalizedInsight).digest('hex').slice(0, 32)

  const decision = await decideOperatorNotification({
    workspaceId: row.workspace_id,
    subjectType: 'business_insight',
    subjectId,
    title: agentResult.replyText.slice(0, 80),
    priority: 'awareness', // pure observation by design — see the module doc comment
    fingerprintParts: [normalizedInsight],
    blockedOnOperator: false,
    resolvableAutonomously: false,
  })

  if (
    decision.outcome === 'SUPPRESS_NO_CHANGE' ||
    decision.outcome === 'SUPPRESS_RECENTLY_NOTIFIED' ||
    decision.outcome === 'RESOLVED_NO_NOTIFICATION'
  ) {
    // finalTurnVisibility: 'internal' — see the matching comment in
    // opportunity-scan/cron/route.ts. A suppressed decision's own
    // concluding text must not render as a chat bubble in Caye Direct;
    // only the audit trail (claude_format) keeps it.
    await persistAgentTurns(
      supabase,
      row.workspace_id,
      agentResult.newTurns,
      operator,
      undefined,
      'Not sent — operator already told, nothing new',
      'whatsapp',
      'internal'
    )
    await supabase
      .from('workspace_ai_config')
      .update({ last_business_insights_sent_at: now.toISOString() })
      .eq('workspace_id', row.workspace_id)
    return { status: 'ok', detail: `suppressed: ${decision.outcome}` }
  }

  // Enqueued, not sent synchronously — dispatch() in the outbound worker
  // picks free-form vs template per-recipient at actual send time, and
  // either way now carries the real insight text, not a "check Caye
  // Direct" placeholder.
  const queued = await enqueueOutbound({
    workspaceId: row.workspace_id,
    kind: 'business_insights',
    payload: {
      freeFormBody: agentResult.replyText,
      attentionSubjectType: 'business_insight',
      attentionSubjectId: subjectId,
    },
    idempotencyKey: `business-insights-${row.workspace_id}-${subjectId}`,
  })

  // Notification in flight the instant it's queued, not once it's actually
  // sent — see the matching comment in lib/whatsapp/triggers.ts.
  if (queued) {
    await markAttentionPending({
      workspaceId: row.workspace_id,
      subjectType: 'business_insight',
      subjectId,
      queueId: queued.id,
    })
  }

  await persistAgentTurns(
    supabase,
    row.workspace_id,
    agentResult.newTurns,
    operator,
    undefined,
    queued ? 'Queued for delivery' : 'Not sent — already queued'
  )

  await supabase
    .from('workspace_ai_config')
    .update({ last_business_insights_sent_at: now.toISOString() })
    .eq('workspace_id', row.workspace_id)

  return { status: 'queued' }
}

function shouldSkip(args: {
  now: Date
  cfg: WorkspaceScheduleConfig
  lastSentAtISO: string | null
  force?: boolean
}): string | null {
  const { now, cfg } = args
  if (cfg.mutedUntil && cfg.mutedUntil > now) return 'muted'
  if (inQuietHours(now, cfg)) return 'quiet_hours'
  if (args.force) return null

  if (localDayOfWeek(now, cfg.timezone) !== TARGET_WEEKDAY) return 'not target weekday'
  if (localHour(now, cfg.timezone) !== TARGET_LOCAL_HOUR) return 'not target hour'

  if (args.lastSentAtISO) {
    const last = new Date(args.lastSentAtISO)
    if (!Number.isNaN(last.getTime()) && now.getTime() - last.getTime() < MIN_GAP_DAYS * 24 * 60 * 60 * 1000) {
      return 'sent recently'
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
