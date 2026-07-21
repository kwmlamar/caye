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

  const supabase = createServiceClient()

  const { data: workspaces, error } = await supabase
    .from('workspace_ai_config')
    .select('workspace_id, whatsapp_outbound_enabled, operator_whatsapp_verified_at')
    .eq('whatsapp_outbound_enabled', true)
    .not('operator_whatsapp_verified_at', 'is', null)

  if (error) {
    console.error('[morning-digest] workspace fetch failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
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

    await enqueueOutbound({
      workspaceId: ws.workspace_id,
      kind: 'morning_digest',
      payload: {
        firstName,
        heldCount: held,
        bookingsTodayCount: bookings,
        agingEscalationsSummary,
      },
      scheduledFor: now,
      idempotencyKey: `digest-${ws.workspace_id}-${dayKey}`,
    })
    summary.queued++
  }

  return NextResponse.json(summary)
}

function pickFirstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null
  const first = fullName.trim().split(/\s+/)[0]
  return first || null
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
