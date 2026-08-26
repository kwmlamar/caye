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
import { createHash } from 'crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { cayeAgent } from '@/lib/caye-agent'
import { enqueueOutbound } from '@/lib/whatsapp/outbound'
import { loadScheduleConfig, inQuietHours, type WorkspaceScheduleConfig } from '@/lib/whatsapp/schedule'
import { resolveOperatorByPhone } from '@/lib/operator-identity'
import { persistAgentTurns } from '@/lib/caye-operator-messages'
import { linkInsertedMessagesToThreads } from '@/lib/caye-direct-threads'
import { recordCronRun } from '@/lib/cron-run-log'
import { decideOperatorNotification } from '@/lib/whatsapp/operator-notification-gate'
import { markAttentionPending } from '@/lib/owner-attention'
import {
  QUIET_SENTINEL,
  isQuietScan,
  stripQuietSentinelFromTurns,
  scrubQuietSentinel,
} from '@/lib/quiet-scan'
import { getActivitySince, isActivityEmpty, type ActivitySince } from '@/lib/caye-agent/activity-since'
import { listActiveEligibleGoals } from '@/lib/goals/goals'
import { sortByPriorityScore } from '@/lib/goals/priority-score'
import type { GoalRow } from '@/lib/goals/types'

const TARGET_LOCAL_HOURS = [10, 14, 18]
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

export async function runOpportunityScan(opts?: { force?: boolean }) {
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
        const result = await processWorkspace(supabase, row, now, opts?.force ?? false)
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
  now: Date,
  force = false
): Promise<{ status: string; detail?: string }> {
  if (!row.operator_whatsapp_number) return { status: 'skip', detail: 'no operator phone' }

  const cfg = await loadScheduleConfig(row.workspace_id)
  const skip = shouldSkip({ now, cfg, lastScanAtISO: row.last_opportunity_scan_at, force })
  if (skip) return { status: 'skip', detail: skip }

  const operator = await resolveOperatorByPhone(supabase, row.workspace_id, row.operator_whatsapp_number)
  if (!operator) return { status: 'skip', detail: 'no operator_allowlist match for operator phone' }

  let activity: ActivitySince | null = null
  if (row.last_opportunity_scan_at && !force) {
    activity = await getActivitySince(row.workspace_id, row.last_opportunity_scan_at)
    if (isActivityEmpty(activity)) {
      await supabase
        .from('workspace_ai_config')
        .update({ last_opportunity_scan_at: now.toISOString() })
        .eq('workspace_id', row.workspace_id)
      return { status: 'skip', detail: 'no activity since last scan' }
    }
  }

  // Informational only: these are structurally workspace-scoped, active and
  // dependency-eligible. They affect prioritization context, never authority.
  const activeGoals = await listActiveEligibleGoals(row.workspace_id)
  const prompt = buildScanPrompt(row.last_opportunity_scan_summary, activity, activeGoals)

  const agentResult = await cayeAgent({
    mode: 'back-office',
    workspaceId: row.workspace_id,
    userMessage: prompt,
    callerRole: operator.role,
    callerName: operator.name,
    operatorId: operator.id,
    origin: 'scan',
  })

  const rawReplyText = agentResult.replyText.trim()
  const quiet = isQuietScan(rawReplyText)
  const replyText = scrubQuietSentinel(rawReplyText)

  await supabase
    .from('workspace_ai_config')
    .update({
      last_opportunity_scan_at: now.toISOString(),
      ...(quiet ? {} : { last_opportunity_scan_summary: replyText.slice(0, MAX_SUMMARY_CHARS) }),
    })
    .eq('workspace_id', row.workspace_id)

  if (quiet) {
    const insertedQuiet = await persistAgentTurns(
      supabase,
      row.workspace_id,
      stripQuietSentinelFromTurns(agentResult.newTurns),
      operator
    )
    await linkInsertedMessagesToThreads(supabase, insertedQuiet.map((r) => r.id), agentResult.linkedThreadIds)
    return { status: 'ok', detail: 'nothing to report' }
  }

  const normalizedFinding = replyText.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400)
  const subjectId = createHash('sha256').update(normalizedFinding).digest('hex').slice(0, 32)

  const decision = await decideOperatorNotification({
    workspaceId: row.workspace_id,
    subjectType: 'scan_finding',
    subjectId,
    title: replyText.slice(0, 80),
    priority: 'awareness',
    fingerprintParts: [normalizedFinding],
    blockedOnOperator: false,
    resolvableAutonomously: false,
  })

  if (
    decision.outcome === 'SUPPRESS_NO_CHANGE' ||
    decision.outcome === 'SUPPRESS_RECENTLY_NOTIFIED' ||
    decision.outcome === 'RESOLVED_NO_NOTIFICATION' ||
    decision.outcome === 'SUPPRESS_OPERATOR_AWARE'
  ) {
    // Keep the complete tool-loop audit trail while preventing the scan's
    // suppressed concluding prose from rendering as an operator-facing
    // Caye Direct bubble. This preserves the owner-awareness fix from #135.
    const inserted = await persistAgentTurns(
      supabase,
      row.workspace_id,
      agentResult.newTurns,
      operator,
      undefined,
      `Not sent — ${
        decision.outcome === 'RESOLVED_NO_NOTIFICATION'
          ? 'already resolved'
          : decision.outcome === 'SUPPRESS_OPERATOR_AWARE'
            ? 'operator already handled this directly'
            : 'operator already told, nothing new'
      }`,
      'whatsapp',
      'internal'
    )
    await linkInsertedMessagesToThreads(supabase, inserted.map((r) => r.id), agentResult.linkedThreadIds)
    return { status: 'ok', detail: `suppressed: ${decision.outcome}` }
  }

  const queued = await enqueueOutbound({
    workspaceId: row.workspace_id,
    kind: 'opportunity_scan',
    payload: {
      freeFormBody: replyText,
      attentionSubjectType: 'scan_finding',
      attentionSubjectId: subjectId,
    },
    idempotencyKey: `opportunity-scan-${row.workspace_id}-${subjectId}`,
  })

  if (queued) {
    await markAttentionPending({
      workspaceId: row.workspace_id,
      subjectType: 'scan_finding',
      subjectId,
      queueId: queued.id,
    })
  }

  const inserted = await persistAgentTurns(
    supabase,
    row.workspace_id,
    agentResult.newTurns,
    operator,
    undefined,
    queued ? 'Queued for delivery' : 'Not sent — already queued'
  )
  await linkInsertedMessagesToThreads(supabase, inserted.map((r) => r.id), agentResult.linkedThreadIds)

  return { status: 'queued' }
}

const SENTINEL_INSTRUCTIONS =
  `If nothing needs surfacing, begin your reply with the exact token ${QUIET_SENTINEL} followed by ` +
  'one short sentence saying so, and nothing else. That token is what tells the system to stay ' +
  "quiet; a reply that only says 'nothing new' in prose gets delivered to the operator as if it " +
  'mattered. Do not use the token if you acted on anything or have something worth their time.'

const REASONING_INSTRUCTIONS =
  'Every action you take and every proposal you make must state your reasoning — what you ' +
  "observed, why it matters, what you recommend and why — never just the bare action. Bad: " +
  "'Cancel hold #421?' Good: 'Hold #421 has been inactive 72h, two reminders went unanswered, " +
  "and it expires in 3h — recommend releasing it."

const ACTION_INSTRUCTIONS =
  'You may act directly using your low-risk tools. For anything needing a high-risk action, ' +
  "propose it via the normal tool — it will stage for the owner's approval, not execute directly."

function buildScanPrompt(lastSummary: string | null, activity: ActivitySince | null, activeGoals: GoalRow[] = []): string {
  const intro = "This is your periodic self-initiated workspace scan, not a message from the operator. "
  const goalsBlock = formatActiveGoalsForPrompt(activeGoals)

  if (!activity) {
    const lastSummaryBlock = lastSummary
      ? `\n\nWhat you flagged or proposed last scan, for reference (don't repeat it unless the situation has clearly escalated):\n${lastSummary}`
      : ''
    return (
      intro +
      'Review current state using your read tools (held queue, calendar, revenue, pending quotes, ' +
      'recent activity) and decide if anything needs attention, the way a good employee doing rounds ' +
      `would. ${ACTION_INSTRUCTIONS} ` +
      "Only surface things that are new or materially worse; don't pad the report with items that " +
      "have simply been sitting unchanged for a while and haven't gotten worse — aging backlog is " +
      "the morning briefing's job, not yours. " +
      `${SENTINEL_INSTRUCTIONS} ${REASONING_INSTRUCTIONS}` +
      lastSummaryBlock +
      goalsBlock
    )
  }

  return (
    intro +
    `Here is everything that changed in the workspace since your last scan (${activity.cutoff}):\n\n` +
    `${formatActivityForPrompt(activity)}\n\n` +
    'Report ONLY on what changed above. Do not re-describe or re-propose anything from the held ' +
    "queue, calendar, or other read tools that isn't listed here — it hasn't moved since you last " +
    "looked at it, and repeating it is exactly the stale-noise problem this scan used to have. You " +
    'may still call your read tools to get more detail on an item listed above (e.g. the full thread ' +
    `behind a new hold) before deciding what to say. ${ACTION_INSTRUCTIONS} ${SENTINEL_INSTRUCTIONS} ` +
    REASONING_INSTRUCTIONS +
    goalsBlock
  )
}

function formatActiveGoalsForPrompt(activeGoals: GoalRow[]): string {
  if (activeGoals.length === 0) return ''
  const ranked = sortByPriorityScore(activeGoals)
  const lines = ranked.slice(0, 8).map((g) => {
    const target = g.targetValue !== null && g.unit ? `, target ${g.targetValue} ${g.unit}` : ''
    return `  - ${g.title} (priority: ${g.priority}${target})`
  })
  return (
    '\n\nCURRENT OBJECTIVES — for context only, this does not change what you may act on. These are ' +
    "what this business is actively trying to accomplish right now; weigh what you notice against " +
    'them (e.g. does a finding help or block one of these) but do not invent new work just because it ' +
    "sounds aligned — evidence, authority, and the usual gates still apply:\n" +
    lines.join('\n')
  )
}

function formatActivityForPrompt(activity: ActivitySince): string {
  const lines: string[] = []
  const newHolds = activity.holdEvents.filter((h) => h.stillHeld)
  const resolvedHolds = activity.holdEvents.filter((h) => !h.stillHeld)

  if (newHolds.length > 0) {
    lines.push('New holds (customer waiting on the operator):')
    for (const h of newHolds) {
      lines.push(`  - ${h.customer ?? 'a customer'} (${h.channel}), held since ${h.markedAt}`)
    }
  }
  if (resolvedHolds.length > 0) {
    lines.push('Holds resolved since your last scan (already dealt with — do not describe as pending):')
    for (const h of resolvedHolds) {
      lines.push(`  - ${h.customer ?? 'a customer'}: ${h.resolution}`)
    }
  }
  if (activity.escalationEvents.length > 0) {
    lines.push('Escalation activity:')
    for (const e of activity.escalationEvents) {
      lines.push(`  - ${e.category} escalation ${e.status} (routed to ${e.routeTo})`)
    }
  }
  if (activity.bookingEvents.length > 0) {
    lines.push('Booking activity:')
    for (const b of activity.bookingEvents) {
      lines.push(`  - ${b.customer ?? 'a customer'}: ${b.event} (${b.status}, ${b.bookingDate})`)
    }
  }
  if (activity.chaseMessages.length > 0) {
    lines.push("Customers who followed up again on an already-held thread (still the operator's call, but they're waiting):")
    for (const m of activity.chaseMessages) {
      lines.push(`  - ${m.customer ?? 'a customer'} followed up at ${m.sentAt}`)
    }
  }
  return lines.join('\n')
}

function shouldSkip(args: {
  now: Date
  cfg: WorkspaceScheduleConfig
  lastScanAtISO: string | null
  force?: boolean
}): string | null {
  const { now, cfg } = args
  if (cfg.mutedUntil && cfg.mutedUntil > now) return 'muted'
  if (inQuietHours(now, cfg)) return 'quiet_hours'
  if (args.force) return null

  const hour = localHour(now, cfg.timezone)
  if (!TARGET_LOCAL_HOURS.includes(hour)) {
    return `not a scan hour (now=${hour} ${cfg.timezone} local, targets=${TARGET_LOCAL_HOURS.join(',')} local)`
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
