/**
 * GET /api/caye/stale-hold-sweep
 *
 * Receptionist-spec.md Q3+5+6+8 reframe (2026-06-22): the dashboard
 * is not the operator's daily surface. Held items live in their email
 * client (drafts) and their attention. This cron sweeps daily and, for
 * each workspace, emails the operator a single rollup of any held
 * conversations whose last business message has gone stale.
 *
 * Stale = no business message in this thread for N business hours. The
 * customer already received Caye's hold acknowledgement (Q7) — this is
 * a nudge to the OPERATOR that they have unanswered drafts, not a
 * second message to the customer.
 *
 * Pile-up fix (2026-07-22): previously the same stale item reappeared in
 * this daily email indefinitely, forever, with no upper bound — a hold
 * from three weeks ago read identically to one from yesterday. Items now
 * age out of the daily rollup after AGED_BACKLOG_DAYS and move into a
 * once-weekly "aged backlog" section instead (still surfaced, never
 * silently dropped — just off the daily cadence). This governs the
 * OPERATOR-facing email only; it does not touch human_agent_enabled or
 * send anything to the customer, so nothing here weakens the "no autosend"
 * guarantee in lib/autosend-gate.ts.
 *
 * Dead-date fix (2026-07-23): a held item can reference a specific calendar
 * date (e.g. a booking request) that passes while the hold sits unanswered
 * — Caye would otherwise keep repeating the same stale ask verbatim forever
 * with no sign the date's dead. unified_conversations.target_date (captured
 * once at hold-creation time — see lib/whatsapp/urgency.ts's
 * extractHoldTargetDate) is checked here: once it's passed, the item skips
 * the usual staleness/quiet-hours gates and the weekly-aging bucket
 * entirely, surfaces immediately at the top of the daily email with a
 * templated suggested reply, and — same principle as the rest of this file
 * — never auto-clears human_agent_enabled. A human still decides.
 *
 * Respects workspace_ai_config.notifications_paused: when paused, the
 * sweep computes the rollup but does NOT send. The would-have-sent
 * payload is logged so you can verify the sweep on a paused workspace
 * without delivering email. (No email-side override exists — phone
 * override applies to WhatsApp pings only.)
 *
 * Secure via CRON_SECRET (x-cron-secret header) matching the nudge-scan
 * pattern.
 *
 * Recommended cadence: once daily at the workspace's morning briefing
 * time. Registered on cron-job.org. Failure to send for one workspace
 * does not block the sweep for others — errors are logged and the
 * scan continues.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { sendZohoEmail } from '@/lib/email-ai'
import { loadScheduleConfig, inQuietHours } from '@/lib/whatsapp/schedule'

const STALE_BUSINESS_HOURS = 4

// Items held this long (measured from human_agent_marked_at, when Caye
// first flagged the thread) age out of the daily rollup and move to the
// once-weekly aged-backlog section instead. Matches the 7-day rhythm
// already used for the founder escalation backstop (FOUNDER_ESCALATION_HOURS)
// so operators get one consistent "a week untouched" mental model across
// the hold/escalation system.
const AGED_BACKLOG_DAYS = 7

// Day the weekly aged-backlog section is included (UTC). Monday.
const WEEKLY_DIGEST_DAY_UTC = 1

interface SweepSummary {
  workspaces_scanned: number
  rollups_sent: number
  rollups_skipped_paused: number
  workspaces_with_no_stale_holds: number
  errors: string[]
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

  const supabase = createServiceClient()
  const summary: SweepSummary = {
    workspaces_scanned: 0,
    rollups_sent: 0,
    rollups_skipped_paused: 0,
    workspaces_with_no_stale_holds: 0,
    errors: [],
  }

  // Active workspaces with an email connected and a contact_email to send to.
  const { data: workspaces } = await supabase
    .from('customers')
    .select('id, business_name, full_name, contact_email')
    .not('contact_email', 'is', null)

  for (const ws of workspaces ?? []) {
    summary.workspaces_scanned++
    try {
      const outcome = await processWorkspace({
        workspaceId: ws.id,
        businessName: ws.business_name,
        operatorName: ws.full_name,
        contactEmail: ws.contact_email,
      })
      if (outcome === 'sent') summary.rollups_sent++
      else if (outcome === 'paused') summary.rollups_skipped_paused++
      else if (outcome === 'no_stale') summary.workspaces_with_no_stale_holds++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`workspace ${ws.id}: ${msg}`)
      console.error(`[stale-hold-sweep] workspace ${ws.id} failed:`, err)
    }
  }

  console.log('[stale-hold-sweep] complete', summary)
  return NextResponse.json(summary)
}

type WorkspaceOutcome = 'sent' | 'paused' | 'no_stale'

interface ProcessArgs {
  workspaceId: string
  businessName: string | null
  operatorName: string | null
  contactEmail: string
}

interface StaleHold {
  conversationId: string
  customerName: string | null
  customerId: string | null
  channelType: string | null
  reason: string | null
  proposedReply: string | null
  lastBusinessAt: string | null
  hoursStale: number
  daysHeld: number
  isDeadDate: boolean
  targetDate: string | null
}

/**
 * Templated (not LLM-generated) suggested reply for a dead-date hold — the
 * customer asked about a specific date that's since passed and never got a
 * real answer. Deliberately a fixed template, not a fresh model call: this
 * only needs to be good enough for the operator to approve or edit, and a
 * cron job calling an LLM per stale item adds cost/latency/failure modes
 * for marginal benefit at current volume (2026-07-23 dead-date fix).
 */
function buildDeadDateSuggestedReply(customerName: string | null, targetDate: string): string {
  const who = customerName?.trim() || 'there'
  const dateLabel = new Date(`${targetDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
  return (
    `Hi ${who.split(' ')[0]}, so sorry for the delayed response — we missed getting back to you ` +
    `about ${dateLabel}, and that date's passed now. If another date works, just let us know and ` +
    `we'll get you booked!`
  )
}

async function processWorkspace(args: ProcessArgs): Promise<WorkspaceOutcome> {
  const supabase = createServiceClient()

  // Find all connected accounts so we can scope conversations to this workspace.
  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', args.workspaceId)
  const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)
  if (accountIds.length === 0) return 'no_stale'

  // Held conversations on those accounts.
  const { data: held } = await supabase
    .from('unified_conversations')
    .select(
      'id, customer_name, customer_id, channel_type, human_agent_reason, human_agent_marked_at, last_message_at, last_business_sender_kind, last_sender_type, target_date'
    )
    .in('connected_account_id', accountIds)
    .eq('human_agent_enabled', true)
    .eq('is_archived', false)
    .limit(200)

  if (!held || held.length === 0) return 'no_stale'

  const cfg = await loadScheduleConfig(args.workspaceId)
  const now = new Date()
  const todayISO = now.toISOString().slice(0, 10)
  const isWeeklyDigestDay = now.getUTCDay() === WEEKLY_DIGEST_DAY_UTC

  // Compute "business hours since last business message" per conversation.
  // Simplified: total elapsed hours minus quiet-hour blocks the elapsed
  // window crossed. Good-enough heuristic for "is this stale?" — exact
  // business-hours math isn't worth the complexity here.
  const stale: StaleHold[] = []
  const agedStale: StaleHold[] = []
  for (const c of held) {
    const lastBusinessAt = (c.last_message_at as string | null) ?? null
    if (!lastBusinessAt) continue

    // Skip if the latest activity on the thread is from the customer —
    // then the held state is waiting on Caye/Karenda's response which
    // they haven't acted on yet, which is the case we want to flag.
    // Skip if the last sender_type is operator (already handled).
    if (c.last_sender_type === 'business' && c.last_business_sender_kind !== 'caye') {
      // Operator already sent something after the Caye hold — not stale.
      continue
    }

    // Dead-date check runs before (and bypasses) the usual staleness/quiet-
    // hours gates below — a booking date that's already passed is worth
    // flagging immediately, not after the normal 4-business-hour /
    // quiet-hours wait. Day-granularity comparison, so "immediately" here
    // just means "don't make it wait for the next gate."
    const targetDate = (c.target_date as string | null) ?? null
    const isDeadDate = !!targetDate && targetDate < todayISO

    const elapsedMs = now.getTime() - new Date(lastBusinessAt).getTime()
    const elapsedHours = elapsedMs / (1000 * 60 * 60)
    if (!isDeadDate) {
      if (elapsedHours < STALE_BUSINESS_HOURS) continue
      // If we're currently in quiet hours, push the alarm to morning; the
      // sweep only triggers when out-of-quiet-hours and the threshold is met.
      if (inQuietHours(now, cfg)) continue
    }

    // Pull the latest Caye internal note for this conversation so we can
    // include the held reason + proposed_reply in the rollup.
    const { data: noteRow } = await supabase
      .from('unified_messages')
      .select('content, metadata')
      .eq('conversation_id', c.id)
      .eq('is_internal', true)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const meta = (noteRow?.metadata ?? {}) as Record<string, unknown>
    const reason =
      (c.human_agent_reason as string | null) ??
      (typeof meta.hold_reason === 'string' ? (meta.hold_reason as string) : null)
    const customerName = (c.customer_name as string | null) ?? null
    // Dead-date holds get a fixed suggested reply instead of whatever Caye
    // originally drafted (which was for the now-dead date, not for what to
    // say once it's passed) — never auto-clears the hold, just gives the
    // operator something to approve/edit instead of composing from scratch.
    const proposedReply = isDeadDate
      ? buildDeadDateSuggestedReply(customerName, targetDate as string)
      : (typeof meta.proposed_reply === 'string' ? (meta.proposed_reply as string) : null)

    // Age from when Caye first flagged the thread, not from last activity —
    // a hold that's been sitting 10 days but had a customer follow-up
    // yesterday is still a 10-day-old pile-up problem, not a fresh one.
    const markedAt = (c.human_agent_marked_at as string | null) ?? lastBusinessAt
    const daysHeld = (now.getTime() - new Date(markedAt).getTime()) / (1000 * 60 * 60 * 24)

    const entry: StaleHold = {
      conversationId: c.id as string,
      customerName,
      customerId: (c.customer_id as string | null) ?? null,
      channelType: (c.channel_type as string | null) ?? null,
      reason,
      proposedReply,
      lastBusinessAt,
      hoursStale: Math.round(elapsedHours * 10) / 10,
      daysHeld: Math.round(daysHeld * 10) / 10,
      isDeadDate,
      targetDate,
    }

    if (isDeadDate) {
      // Always daily, never demoted to the weekly bucket — a dead date is
      // exactly the kind of thing that shouldn't wait a week to surface.
      stale.push(entry)
    } else if (daysHeld >= AGED_BACKLOG_DAYS) {
      agedStale.push(entry)
    } else {
      stale.push(entry)
    }
  }

  // Dead-date items float to the top of the daily list.
  stale.sort((a, b) => Number(b.isDeadDate) - Number(a.isDeadDate))

  if (stale.length === 0 && (!isWeeklyDigestDay || agedStale.length === 0)) return 'no_stale'

  // Compose the rollup — aged-backlog section only included on the weekly
  // digest day, so daily emails stay focused on genuinely fresh items.
  const { subject, body } = composeRollup(args, stale, isWeeklyDigestDay ? agedStale : [])

  // Pause gate — log and skip the send.
  const { data: notifCfg } = await supabase
    .from('workspace_ai_config')
    .select('notifications_paused')
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (notifCfg?.notifications_paused === true) {
    console.log(
      `[stale-hold-sweep] paused — would have sent to ${args.contactEmail}:\nSUBJECT: ${subject}\n\n${body}`
    )
    return 'paused'
  }

  await sendZohoEmail(args.contactEmail, subject, body, args.workspaceId)
  console.log(
    `[stale-hold-sweep] sent rollup to ${args.contactEmail} for workspace ${args.workspaceId} (${stale.length} stale)`
  )
  return 'sent'
}

function composeRollup(
  args: ProcessArgs,
  stale: StaleHold[],
  agedStale: StaleHold[] = []
): { subject: string; body: string } {
  const opName = args.operatorName?.trim() || 'there'
  const bizName = args.businessName?.trim() || 'your business'
  const n = stale.length
  const subjectParts = [n > 0 ? `${n} ${n === 1 ? 'thread' : 'threads'}` : null,
    agedStale.length > 0 ? `${agedStale.length} aged` : null].filter(Boolean)
  const subject = `${subjectParts.join(' + ')} waiting on you — ${bizName}`

  const lines: string[] = []
  lines.push(`Hi ${opName.split(' ')[0]},`)
  lines.push('')

  if (n > 0) {
    lines.push(
      `${n === 1 ? 'One customer thread is' : `${n} customer threads are`} still waiting ` +
        `on your call — I held ${n === 1 ? 'it' : 'them'} earlier and the customer hasn't heard back.`
    )
    lines.push('')

    for (const h of stale) {
      const who = h.customerName || h.customerId || 'A customer'
      const ch = h.channelType ? ` (${h.channelType})` : ''
      if (h.isDeadDate) {
        lines.push(`⚠️ — ${who}${ch} — asked about ${h.targetDate}, which has already passed`)
      } else {
        lines.push(`— ${who}${ch} — ${h.hoursStale}h since last reply`)
      }
      if (h.reason) lines.push(`    Why I held: ${h.reason}`)
      if (h.proposedReply) {
        const trimmed = h.proposedReply.replace(/\s+/g, ' ').trim()
        const preview = trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed
        const label = h.isDeadDate ? 'Suggested reply (date already passed)' : 'Draft I wrote'
        lines.push(`    ${label}: "${preview}"`)
      }
      lines.push('')
    }
  }

  if (agedStale.length > 0) {
    lines.push(
      `Weekly aged backlog — these have been sitting ${AGED_BACKLOG_DAYS}+ days with no ` +
        `action, so I've stopped including them in the daily email. Still open, still waiting on you:`
    )
    lines.push('')
    for (const h of agedStale) {
      const who = h.customerName || h.customerId || 'A customer'
      const ch = h.channelType ? ` (${h.channelType})` : ''
      lines.push(`— ${who}${ch} — held ${h.daysHeld}d`)
      if (h.reason) lines.push(`    Why I held: ${h.reason}`)
      lines.push('')
    }
  }

  lines.push(
    "When you're ready, open the thread in your email and reply — I'll pick up the response and stop nudging you."
  )
  lines.push('')
  lines.push('— Caye')

  return { subject, body: lines.join('\n') }
}
