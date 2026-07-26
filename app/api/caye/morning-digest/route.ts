/**
 * GET /api/caye/morning-digest
 *
 * Hourly cron — fires the per-workspace morning digest when the workspace's
 * local time is 7am. Idempotent on the day: a duplicate enqueue is silently
 * rejected by the unique key on caye_outbound_queue.idempotency_key.
 *
 * Skips the digest entirely when there's nothing held + no same-day bookings.
 *
 * As of 2026-07-21 this also carries the once-daily "still aging" escalation
 * list that used to be its own standalone escalation_followup ping per stale
 * escalation (see app/api/caye/escalation-followup/cron/route.ts and
 * decisions-log.md 2026-07-21 for why that was a wall of near-identical
 * texts). buildAgingEscalationsSummary() below owns the query + the
 * once-a-day repeat window (FOLLOWUP_REPEAT_HOURS) for that list; the
 * escalation-followup cron no longer touches follow_up_sent_at at all.
 *
 * Secured by CRON_SECRET via x-cron-secret header.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOutbound } from '@/lib/whatsapp/outbound'
import { loadScheduleConfig, isDigestHour } from '@/lib/whatsapp/schedule'
import { recordCronRun } from '@/lib/cron-run-log'
import { composeMorningBriefing } from '@/lib/caye-agent/briefing'
import { resolveOperatorByPhone } from '@/lib/operator-identity'
import {
  AGING_LIST_MAX_ITEMS,
  ESCALATION_FOLLOWUP_HOURS,
  FOLLOWUP_REPEAT_HOURS,
  LOOKBACK_HOURS,
  formatAge,
  resolveContactName,
} from '@/lib/whatsapp/escalation-followup'

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const provided = request.headers.get('x-cron-secret')
    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    return NextResponse.json(await runMorningDigest())
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Core digest logic, extracted so both the scheduled cron hit above AND
 * the founder-triggered manual run (lib/caye-agent/tools/admin/write-high/
 * trigger-cron.ts, via Admin Shell) call the exact same code — no
 * duplicated logic, no drift between the two invocation paths.
 */
export async function runMorningDigest() {
  return recordCronRun('morning-digest', async () => {
  const supabase = createServiceClient()

  const { data: workspaces, error } = await supabase
    .from('workspace_ai_config')
    .select(
      'workspace_id, whatsapp_outbound_enabled, operator_whatsapp_verified_at, operator_whatsapp_number, operator_notification_override_phone'
    )
    .eq('whatsapp_outbound_enabled', true)
    .not('operator_whatsapp_verified_at', 'is', null)

  if (error) {
    console.error('[morning-digest] workspace fetch failed:', error)
    throw new Error(error.message)
  }

  const now = new Date()
  const dayKey = now.toISOString().slice(0, 10)
  const summary = { scanned: 0, queued: 0, skipped_no_state: 0, skipped_wrong_hour: 0 }

  for (const ws of workspaces ?? []) {
    summary.scanned++

    const cfg = await loadScheduleConfig(ws.workspace_id)
    if (!isDigestHour(now, cfg)) {
      summary.skipped_wrong_hour++
      continue
    }

    const [{ count: heldCount }, { count: bookingsCount }, { data: customer }] = await Promise.all([
      supabase
        .from('unified_conversations')
        .select('id, connected_account:connected_accounts!inner(user_id)', { count: 'exact', head: true })
        .eq('connected_account.user_id', ws.workspace_id)
        .eq('human_agent_enabled', true),
      supabase
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', ws.workspace_id)
        .eq('booking_date', dayKey),
      supabase.from('customers').select('full_name, business_name').eq('id', ws.workspace_id).maybeSingle(),
    ])

    const held = heldCount ?? 0
    const bookings = bookingsCount ?? 0
    if (held === 0 && bookings === 0) {
      summary.skipped_no_state++
      continue
    }

    const firstName = pickFirstName(customer?.full_name) ?? customer?.business_name ?? 'there'
    const agingEscalationsSummary = await buildAgingEscalationsSummary(ws.workspace_id, now)

    // Narrative briefing is the real morning message whenever the WhatsApp
    // 24h window is open at send time (see outbound-worker's dispatch()) —
    // the flat count fields above stay only as the template fallback for a
    // closed window or a composition failure. Resolve the greeting name
    // from operator_allowlist against the phone this will actually send to,
    // not customers.full_name — that's a business-level field (Bimini's is
    // literally the string "Mrs. Max") and greeting whoever picks up with
    // it is wrong regardless of who that is. Confirmed live 2026-07-25:
    // this exact bug sent "Morning, Mrs. Max" into Karenda's WhatsApp.
    const destPhone = ws.operator_notification_override_phone ?? ws.operator_whatsapp_number
    let narrativeBody: string | null = null
    if (destPhone) {
      try {
        const operator = await resolveOperatorByPhone(supabase, ws.workspace_id, destPhone)
        const oldestAgingHold = await findOldestAgingHold(ws.workspace_id, now)
        narrativeBody = await composeMorningBriefing({
          workspaceId: ws.workspace_id,
          operatorName: operator?.name ?? null,
          oldestAgingHold,
        })
      } catch (err) {
        console.error(`[morning-digest] composeMorningBriefing failed for ${ws.workspace_id}:`, err)
      }
    }

    await enqueueOutbound({
      workspaceId: ws.workspace_id,
      kind: 'morning_digest',
      payload: {
        firstName,
        heldCount: held,
        bookingsTodayCount: bookings,
        agingEscalationsSummary,
        narrativeBody,
      },
      scheduledFor: now,
      idempotencyKey: `digest-${ws.workspace_id}-${dayKey}`,
    })
    summary.queued++
  }

  return summary
  })
}

function pickFirstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null
  const first = fullName.trim().split(/\s+/)[0]
  return first || null
}

const AGING_HOLD_MIN_DAYS = 3

/**
 * The single oldest currently-held conversation for a workspace, regardless
 * of channel or escalation status — deliberately NOT scoped to
 * caye_escalations like buildAgingEscalationsSummary below, because some
 * holds never get an escalation row at all (nicole silvera, held 19d, zero
 * escalation rows — confirmed live 2026-07-26) or have escalations that
 * expired without the underlying hold ever clearing (Marissa McGourthy,
 * 17d, 5 expired escalations, hold still open). Both fall through every
 * existing nag mechanism — buildAgingEscalationsSummary's own LOOKBACK_HOURS
 * window wouldn't even reach back far enough to catch either of them.
 *
 * Fed into composeMorningBriefing as a must-mention override — get_held_queue's
 * own "most pressing" pick is otherwise free to surface whatever's freshest
 * today, which is exactly how an old hold rots in "+N more" forever. Null
 * when nothing's been held AGING_HOLD_MIN_DAYS+ — a fresh same-morning hold
 * doesn't need this override; B1's real-time ping and normal briefing
 * prioritization already cover it.
 */
async function findOldestAgingHold(
  workspaceId: string,
  now: Date
): Promise<{ customer: string; daysHeld: number } | null> {
  const supabase = createServiceClient()
  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', workspaceId)
  const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)
  if (accountIds.length === 0) return null

  const { data, error } = await supabase
    .from('unified_conversations')
    .select('customer_name, customer_id, human_agent_marked_at')
    .in('connected_account_id', accountIds)
    .eq('is_archived', false)
    .eq('human_agent_enabled', true)
    .not('human_agent_marked_at', 'is', null)
    .order('human_agent_marked_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[morning-digest] oldest-aging-hold fetch failed:', error)
    return null
  }
  if (!data?.human_agent_marked_at) return null

  const daysHeld = Math.floor(
    (now.getTime() - new Date(data.human_agent_marked_at).getTime()) / (24 * 60 * 60 * 1000)
  )
  if (daysHeld < AGING_HOLD_MIN_DAYS) return null

  return { customer: data.customer_name || data.customer_id || 'a customer', daysHeld }
}

interface AgingEscalationCandidate {
  id: string
  conversation_id: string | null
  created_at: string
}

/**
 * Oldest-first, capped "still aging" list for the once-daily digest — e.g.
 * "Jeff Dworkin — 6d, Charlene Volmy — 2d, and 2 more." Empty string when
 * nothing qualifies, so the template placeholder can sit blank rather than
 * needing a conditional (Meta templates don't support those).
 *
 * Marks follow_up_sent_at on every candidate row found (not just the ones
 * that make the capped list) so a big backlog doesn't re-surface the same
 * overflow items again tomorrow — they'll rotate into the visible list
 * once older ones resolve, at most once/day either way.
 */
async function buildAgingEscalationsSummary(workspaceId: string, now: Date): Promise<string> {
  const supabase = createServiceClient()
  const cutoff = new Date(now.getTime() - ESCALATION_FOLLOWUP_HOURS * 60 * 60 * 1000).toISOString()
  const lookback = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
  const repeatCutoff = new Date(now.getTime() - FOLLOWUP_REPEAT_HOURS * 60 * 60 * 1000).toISOString()

  const { data: rows, error } = await supabase
    .from('caye_escalations')
    .select('id, conversation_id, created_at')
    .eq('workspace_id', workspaceId)
    .is('owner_responded_at', null)
    .is('expired_at', null)
    .in('route_to', ['owner', 'both'])
    .or(`follow_up_sent_at.is.null,follow_up_sent_at.lte.${repeatCutoff}`)
    .lte('created_at', cutoff)
    .gte('created_at', lookback)
    .order('created_at', { ascending: true })
    .limit(50)

  if (error) {
    console.error('[morning-digest] aging-escalation fetch failed:', error)
    return ''
  }
  if (!rows?.length) return ''

  const candidates = rows as AgingEscalationCandidate[]
  const entries = await Promise.all(
    candidates.map(async (row) => {
      const contactName = await resolveContactName(row.conversation_id)
      const ageHours = (now.getTime() - new Date(row.created_at).getTime()) / (60 * 60 * 1000)
      return `${contactName} — ${formatAge(ageHours)}`
    })
  )

  await supabase
    .from('caye_escalations')
    .update({ follow_up_sent_at: now.toISOString() })
    .in(
      'id',
      candidates.map((row) => row.id)
    )

  const shown = entries.slice(0, AGING_LIST_MAX_ITEMS)
  const overflow = entries.length - shown.length
  return overflow > 0 ? `${shown.join(', ')}, and ${overflow} more.` : `${shown.join(', ')}.`
}
