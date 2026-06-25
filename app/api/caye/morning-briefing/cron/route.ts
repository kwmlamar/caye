/**
 * GET /api/caye/morning-briefing/cron
 *
 * Hourly cron — checks every workspace with a configured briefing_time
 * and sends the morning briefing if (a) it's currently the briefing
 * hour in the workspace's local timezone and (b) we haven't sent a
 * briefing yet today (in local time).
 *
 * Authenticated via CRON_SECRET. Accepts either `x-cron-secret: <secret>`
 * or `Authorization: Bearer <secret>`. Registered on cron-job.org.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { composeMorningBriefing } from '@/lib/caye-agent/briefing'
import { sendFreeFormWhatsApp } from '@/lib/whatsapp/outbound'

interface WorkspaceRow {
  workspace_id: string
  briefing_time: string
  last_briefing_sent_at: string | null
  operator_whatsapp_number: string | null
  whatsapp_muted_until: string | null
  customers: { timezone: string | null } | { timezone: string | null }[] | null
}

export async function GET(request: NextRequest) {
  // Accept either Authorization: Bearer <secret> or x-cron-secret: <secret>
  // — matches outbound-worker so all cron-job.org jobs share one header shape.
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const supabase = createServiceClient()
  const nowISO = new Date().toISOString()

  // Pull every workspace eligible for a briefing.
  const { data: rows, error } = await supabase
    .from('workspace_ai_config')
    .select(
      'workspace_id, briefing_time, last_briefing_sent_at, operator_whatsapp_number, whatsapp_muted_until, customers(timezone)'
    )
    .not('briefing_time', 'is', null)
    .not('operator_whatsapp_number', 'is', null)
    .eq('whatsapp_outbound_enabled', true)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const results: Array<{ workspace_id: string; status: string; detail?: string }> = []
  for (const row of (rows ?? []) as unknown as WorkspaceRow[]) {
    const tz = pickTimezone(row.customers)
    try {
      const decision = decideEligibility({
        nowISO,
        briefingTimeStr: row.briefing_time,
        lastSentAtISO: row.last_briefing_sent_at,
        timezone: tz,
        mutedUntilISO: row.whatsapp_muted_until,
      })
      if (decision.skip) {
        results.push({ workspace_id: row.workspace_id, status: 'skip', detail: decision.reason })
        continue
      }
      if (!row.operator_whatsapp_number) {
        results.push({ workspace_id: row.workspace_id, status: 'skip', detail: 'no operator number' })
        continue
      }

      const briefingText = await composeMorningBriefing({ workspaceId: row.workspace_id })
      if (!briefingText) {
        results.push({ workspace_id: row.workspace_id, status: 'skip', detail: 'empty composition' })
        continue
      }

      const idempotencyKey = `briefing-${row.workspace_id}-${todayInTimezone(tz)}`
      const sendResult = await sendFreeFormWhatsApp(
        row.operator_whatsapp_number,
        briefingText,
        idempotencyKey
      )
      if (sendResult.status === 'failed') {
        results.push({
          workspace_id: row.workspace_id,
          status: 'send_failed',
          detail: sendResult.error,
        })
        continue
      }

      // Stamp sent. Persist outbound row for audit.
      await supabase
        .from('workspace_ai_config')
        .update({ last_briefing_sent_at: nowISO })
        .eq('workspace_id', row.workspace_id)

      await supabase.from('caye_operator_messages').insert({
        workspace_id: row.workspace_id,
        direction: 'outbound',
        wa_message_id: null,
        body: briefingText,
        intent: null,
        claude_format: { role: 'assistant', content: briefingText },
      })

      results.push({ workspace_id: row.workspace_id, status: 'sent' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[morning-briefing] workspace ${row.workspace_id}:`, msg)
      results.push({ workspace_id: row.workspace_id, status: 'error', detail: msg })
    }
  }

  return NextResponse.json({ checked: results.length, results })
}

function pickTimezone(
  cust: WorkspaceRow['customers']
): string {
  if (!cust) return 'America/Nassau'
  const tz = Array.isArray(cust) ? cust[0]?.timezone : cust.timezone
  return tz?.trim() || 'America/Nassau'
}

/**
 * Decide whether to send a briefing right now for a given workspace.
 * Pure function, easy to reason about in isolation.
 */
function decideEligibility(args: {
  nowISO: string
  briefingTimeStr: string
  lastSentAtISO: string | null
  timezone: string
  mutedUntilISO: string | null
}): { skip: boolean; reason?: string } {
  const now = new Date(args.nowISO)
  // Mute check.
  if (args.mutedUntilISO) {
    const mutedUntil = new Date(args.mutedUntilISO)
    if (!Number.isNaN(mutedUntil.getTime()) && mutedUntil > now) {
      return { skip: true, reason: 'muted' }
    }
  }

  const briefingHour = parseInt(args.briefingTimeStr.slice(0, 2), 10)
  const currentHour = hourInTimezone(now, args.timezone)
  if (currentHour !== briefingHour) {
    return { skip: true, reason: `not briefing hour (now=${currentHour}, target=${briefingHour})` }
  }

  if (args.lastSentAtISO) {
    const lastSent = new Date(args.lastSentAtISO)
    if (
      !Number.isNaN(lastSent.getTime()) &&
      sameLocalDay(lastSent, now, args.timezone)
    ) {
      return { skip: true, reason: 'already sent today' }
    }
  }

  return { skip: false }
}

function hourInTimezone(d: Date, tz: string): number {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    })
    return parseInt(f.format(d), 10)
  } catch {
    return d.getUTCHours()
  }
}

function todayInTimezone(tz: string): string {
  try {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    return f.format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

function sameLocalDay(a: Date, b: Date, tz: string): boolean {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return f.format(a) === f.format(b)
}
