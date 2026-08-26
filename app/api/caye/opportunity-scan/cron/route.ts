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
 *  run updates the health row exactly like a scheduled one.
 *
 *  opts.force (2026-08-01, admin-shell manual trigger only — the real GET
 *  cron never passes this): bypasses the target-hour/already-ran cadence
 *  gate so a founder testing this doesn't have to wait for 10/14/18 local.
 *  Deliberately does NOT bypass muted/quiet_hours — those are the owner's
 *  own do-not-disturb preference, and a founder choosing to force a test
 *  run shouldn't be able to override that for a live paying customer. */
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

  // Pre-LLM change-gate (2026-08-07). Caye can't repeat a stale finding if
  // she never runs — the root cause of the 2026-08-06 noise wasn't a
  // prompt-compliance failure, it was running a real tool-loop against a
  // held queue that hadn't moved in days. Bypassed on the very first scan
  // for a workspace (no stored cutoff — run once as a baseline per the
  // cutover decision, see the design note in decisions-log.md) and on a
  // forced admin test run (force verifies the scan still works end to
  // end, not that it stays quiet). See lib/caye-agent/activity-since.ts.
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

  // Goal-aware context (2026-08-26) — purely informational. This does not
  // change what Caye may act on: ACTION_INSTRUCTIONS below is unchanged,
  // low-risk tools still execute directly and high-risk tools still stage
  // through gateHighRisk. It only tells her WHY the workspace's current
  // priorities are what they are, so a finding can be weighed against them
  // instead of reported in a vacuum. Never operator/global-scope goals —
  // listActiveEligibleGoals only ever returns this workspace's own rows.
  const activeGoals = await listActiveEligibleGoals(row.workspace_id)

  const prompt = buildScanPrompt(row.last_opportunity_scan_summary, activity, activeGoals)

  // The caller IS the recipient. This used to hardcode callerRole 'founder'
  // with no name, which made the prompt tell Caye the founder was listening
  // while the result was persisted to and delivered at `operator`'s number —
  // so she wrote founder-facing reports about the owner ("worth checking
  // with Mrs. Max") and sent them to Mrs. Max (2026-08-06).
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
  // Scrub unconditionally, not just on the quiet branch: on 2026-08-08 the
  // detector missed a misplaced token AND the only strip was gated behind
  // that same detector, so the raw sentinel rendered in Karenda's thread.
  // Presentation must not depend on the classification being right.
  const replyText = scrubQuietSentinel(rawReplyText)

  // Always record that the round happened — the cadence gate and Admin
  // Shell both read this timestamp. Only overwrite the "what I flagged"
  // summary when something WAS flagged: a quiet round shouldn't erase the
  // context that stops the next scan repeating a finding.
  await supabase
    .from('workspace_ai_config')
    .update({
      last_opportunity_scan_at: now.toISOString(),
      ...(quiet ? {} : { last_opportunity_scan_summary: replyText.slice(0, MAX_SUMMARY_CHARS) }),
    })
    .eq('workspace_id', row.workspace_id)

  if (quiet) {
    // Persist the turns (caye_operator_messages is the only audit trail
    // for anything Caye acted on with a low-risk tool this round) but as a
    // log-only row — no delivery status, no send, no ping, no alert. A
    // quiet round is a non-event, and every downstream noise source below
    // exists to surface findings, not to announce that there weren't any.
    const insertedQuiet = await persistAgentTurns(
      supabase,
      row.workspace_id,
      stripQuietSentinelFromTurns(agentResult.newTurns),
      operator
    )
    await linkInsertedMessagesToThreads(supabase, insertedQuiet.map((r) => r.id), agentResult.linkedThreadIds)
    return { status: 'ok', detail: 'nothing to report' }
  }

  // Does the operator need to know or do something NEW — not "did the scan
  // produce text." Keyed on the finding's own normalized content (cheap
  // text normalization, not semantic classification) so a re-run that
  // rediscovers the exact same thing collapses onto the same attention
  // item instead of minting a fresh one every scan. This is what stops an
  // already-pinged escalation from getting re-narrated as a "workspace scan
  // finding" a few hours later on a different code path (2026-08-13).
  const normalizedFinding = replyText.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400)
  const subjectId = createHash('sha256').update(normalizedFinding).digest('hex').slice(0, 32)

  const decision = await decideOperatorNotification({
    workspaceId: row.workspace_id,
    subjectType: 'scan_finding',
    subjectId,
    title: replyText.slice(0, 80),
    // Genuinely urgent/actionable findings already have their own stronger
    // path (escalations, holds) — what reaches here as a *scan's own*
    // finding is informational by construction, so it gets the FYI tier:
    // said once, no auto-reminder, and subject to the low-priority cooldown
    // so it doesn't stack with whatever else just pinged this operator.
    priority: 'awareness',
    fingerprintParts: [normalizedFinding],
    blockedOnOperator: false,
    resolvableAutonomously: false,
  })

  if (
    decision.outcome === 'SUPPRESS_NO_CHANGE' ||
    decision.outcome === 'SUPPRESS_RECENTLY_NOTIFIED' ||
    decision.outcome === 'RESOLVED_NO_NOTIFICATION'
  ) {
    const inserted = await persistAgentTurns(
      supabase,
      row.workspace_id,
      agentResult.newTurns,
      operator,
      undefined,
      `Not sent — ${decision.outcome === 'RESOLVED_NO_NOTIFICATION' ? 'already resolved' : 'operator already told, nothing new'}`
    )
    await linkInsertedMessagesToThreads(supabase, inserted.map((r) => r.id), agentResult.linkedThreadIds)
    return { status: 'ok', detail: `suppressed: ${decision.outcome}` }
  }

  // Enqueued, not sent synchronously — dispatch() picks free-form vs
  // template per-recipient at actual send time (more accurate than this
  // cron tick's snapshot), and either way now carries the real finding, not
  // a "come look at Caye Direct" placeholder (freeFormBodyForKind /
  // templateForKind in the outbound worker). attentionSubjectType/Id let
  // the worker's post-send stamp find this exact attention row.
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

  // Notification in flight the instant it's queued, not once it's actually
  // sent — see the matching comment in lib/whatsapp/triggers.ts.
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

// The token is load-bearing, not decoration — it's the only thing the cron
// can check to tell a quiet round from a real finding, and the difference
// decides whether the owner gets pinged. Spelled out because a model that
// writes "nothing new this scan" in prose reads to itself as having
// complied.
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

/**
 * activity === null means either the very first scan for this workspace
 * (no stored last_opportunity_scan_at to gate against) or a forced admin
 * test run — both intentionally get the old free-look behavior: review
 * everything, decide what's worth a baseline report.
 *
 * activity !== null means processWorkspace's pre-LLM gate already
 * confirmed something changed since the last scan — the prompt then
 * scopes her to that computed delta instead of a fresh open-ended look,
 * so a resolved or unchanged item can't get re-described just because
 * her read tools can still see it.
 */
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

/**
 * Additive, informational-only context block (2026-08-26) — the smallest
 * integration point for goal-aware proactive reasoning: it tells Caye WHY
 * the workspace's current priorities are what they are, so a finding can be
 * weighed against them ("this holds up the trial-conversion objective")
 * instead of reported in a vacuum. It does not instruct her to invent new
 * work, does not grant any new tool access, and does not change
 * ACTION_INSTRUCTIONS/SENTINEL_INSTRUCTIONS above. Empty when the workspace
 * has no active goals — every workspace that hasn't adopted goals yet sees
 * an unchanged prompt, matching formatBusinessFactsBlock's empty-string
 * convention in lib/business-facts.ts.
 */
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
    // Explicitly labeled "local" — cayeAgent narrates this string verbatim to
    // the founder, and without a label it's guessed "UTC" once already
    // (2026-08-01 manual trigger_cron test), which is wrong and would read
    // as a timezone bug that doesn't actually exist.
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
