/**
 * GET /api/caye/escalation-followup/cron
 *
 * Hourly cron, all workspaces — the housekeeping half of escalation
 * follow-up. As of 2026-07-21 this no longer sends an owner-facing "still
 * waiting" ping itself: that was firing one separate WhatsApp text per
 * stale escalation, which piled into a wall of near-identical texts on the
 * owner's phone whenever several escalations crossed the follow-up
 * threshold in the same run. That owner-facing surface moved into the
 * once-daily morning_digest message instead (see
 * app/api/caye/morning-digest/route.ts and decisions-log.md 2026-07-21),
 * which caps this category at exactly one message/day regardless of
 * backlog size.
 *
 * What stays here, every hour, across all workspaces:
 *   1. Resolved-detection — if the operator replied on the conversation
 *      since the escalation opened, mark owner_responded_at and stop
 *      nudging (any channel counts; see operatorRepliedSince).
 *   2. Expiry — if target_date has passed with no response, mark
 *      expired_at, clear the conversation's hold flag, and log a closing
 *      note to caye_operator_messages. No WhatsApp send for this: the note
 *      itself says "no reply needed", so pushing it to a phone is pure
 *      noise (see expireEscalationLogOnly in escalation-followup.ts).
 *   3. Founder backstop — owner-routed escalations that sit unresolved
 *      past FOUNDER_ESCALATION_HOURS (7d) / FOUNDER_ESCALATION_URGENT_HOURS
 *      (24h, time-sensitive holds) get a one-shot ping to the founder.
 *      Unaffected by the digest-merge change: different recipient, already
 *      one-shot, not part of the wall-of-texts problem.
 *
 * Authenticated via CRON_SECRET. Accepts either `x-cron-secret: <secret>`
 * or `Authorization: Bearer <secret>`. Registered on cron-job.org.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import {
  ESCALATION_FOLLOWUP_HOURS,
  LOOKBACK_HOURS,
  composeFollowupPingSummary,
  expireEscalationLogOnly,
  maybeEscalateToFounder,
  operatorRepliedSince,
  resolveContactName,
  type EscalationRow,
} from '@/lib/whatsapp/escalation-followup'

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    // Accept both shapes for consistency with outbound-worker — Bearer for
    // Vercel cron / standard clients, x-cron-secret for cron-job.org's
    // simpler header model.
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const supabase = createServiceClient()
  const now = Date.now()
  const cutoff = new Date(now - ESCALATION_FOLLOWUP_HOURS * 60 * 60 * 1000).toISOString()
  const lookback = new Date(now - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()

  const { data: rows, error } = await supabase
    .from('caye_escalations')
    .select(
      'id, workspace_id, conversation_id, category, route_to, customer_facing_message, internal_context, ping_summary, created_at, founder_escalated_at, target_date'
    )
    .is('owner_responded_at', null)
    .is('expired_at', null)
    .lte('created_at', cutoff)
    .gte('created_at', lookback)
    .order('created_at', { ascending: true })
    .limit(100)

  if (error) {
    console.error('[escalation-followup] fetch failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const summary = {
    scanned: rows?.length ?? 0,
    resolved: 0,
    expired: 0,
    founder_escalated: 0,
    skipped: 0,
  }
  if (!rows?.length) return NextResponse.json(summary)

  for (const row of rows as EscalationRow[]) {
    const outcome = await processEscalation(row)
    summary[outcome.status] += 1
    if (outcome.founderEscalated) summary.founder_escalated += 1
  }

  return NextResponse.json(summary)
}

type Status = 'resolved' | 'expired' | 'skipped'

async function processEscalation(
  row: EscalationRow
): Promise<{ status: Status; founderEscalated: boolean }> {
  const supabase = createServiceClient()

  if (row.conversation_id) {
    const replied = await operatorRepliedSince(row.conversation_id, row.created_at)
    if (replied) {
      await supabase
        .from('caye_escalations')
        .update({ owner_responded_at: new Date().toISOString() })
        .eq('id', row.id)
      return { status: 'resolved', founderEscalated: false }
    }
  }

  const contactName = await resolveContactName(row.conversation_id)

  // The underlying window already passed (e.g. a specific booking date)
  // with no operator response. Nudging about a dead date is just noise —
  // log a closing note and stop selecting this row entirely (no WhatsApp
  // send — see expireEscalationLogOnly's docstring).
  const todayISO = new Date().toISOString().slice(0, 10)
  if (row.target_date && row.target_date < todayISO) {
    try {
      await expireEscalationLogOnly(row, contactName)
    } catch (err) {
      console.error('[escalation-followup] expiry logging failed:', err)
      return { status: 'skipped', founderEscalated: false }
    }
    return { status: 'expired', founderEscalated: false }
  }

  // Only owner-routed escalations need the founder backstop — founder/both
  // routed rows already have the founder in the loop.
  if (row.route_to !== 'owner') {
    return { status: 'skipped', founderEscalated: false }
  }

  const pingSummary = composeFollowupPingSummary(row)
  const founderEscalated = await maybeEscalateToFounder(row, contactName, pingSummary)
  return { status: 'skipped', founderEscalated }
}
