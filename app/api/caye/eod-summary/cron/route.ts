/**
 * GET /api/caye/eod-summary/cron
 *
 * Hourly cron — for each workspace with eod_summary_enabled=true, sends
 * the EOD recap when the current hour in their local timezone matches
 * eod_summary_time. Identical shape to morning-briefing/cron; we keep
 * them separate so they can be enabled / disabled / rate-limited
 * independently as the product grows.
 *
 * Configured in vercel.json; authenticated via CRON_SECRET bearer.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { composeEodSummary } from '@/lib/caye-agent/briefing'
import { sendFreeFormWhatsApp } from '@/lib/whatsapp/outbound'

interface WorkspaceRow {
  workspace_id: string
  eod_summary_time: string | null
  last_eod_sent_at: string | null
  operator_whatsapp_number: string | null
  whatsapp_muted_until: string | null
  customers: { timezone: string | null } | { timezone: string | null }[] | null
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const provided = request.headers.get('authorization')
    if (provided !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const supabase = createServiceClient()
  const nowISO = new Date().toISOString()

  const { data: rows, error } = await supabase
    .from('workspace_ai_config')
    .select(
      'workspace_id, eod_summary_time, last_eod_sent_at, operator_whatsapp_number, whatsapp_muted_until, customers(timezone)'
    )
    .eq('eod_summary_enabled', true)
    .not('operator_whatsapp_number', 'is', null)
    .eq('whatsapp_outbound_enabled', true)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const results: Array<{ workspace_id: string; status: string; detail?: string }> = []
  for (const row of (rows ?? []) as unknown as WorkspaceRow[]) {
    if (!row.eod_summary_time || !row.operator_whatsapp_number) {
      results.push({ workspace_id: row.workspace_id, status: 'skip', detail: 'missing config' })
      continue
    }
    const tz = pickTimezone(row.customers)
    const skip = shouldSkip({
      nowISO,
      targetTime: row.eod_summary_time,
      lastSentAtISO: row.last_eod_sent_at,
      timezone: tz,
      mutedUntilISO: row.whatsapp_muted_until,
    })
    if (skip) {
      results.push({ workspace_id: row.workspace_id, status: 'skip', detail: skip })
      continue
    }

    try {
      const text = await composeEodSummary({ workspaceId: row.workspace_id })
      if (!text) {
        results.push({ workspace_id: row.workspace_id, status: 'skip', detail: 'empty composition' })
        continue
      }
      const idempotencyKey = `eod-${row.workspace_id}-${todayInTimezone(tz)}`
      const sendResult = await sendFreeFormWhatsApp(
        row.operator_whatsapp_number,
        text,
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

      await supabase
        .from('workspace_ai_config')
        .update({ last_eod_sent_at: nowISO })
        .eq('workspace_id', row.workspace_id)

      await supabase.from('caye_operator_messages').insert({
        workspace_id: row.workspace_id,
        direction: 'outbound',
        wa_message_id: null,
        body: text,
        intent: null,
        claude_format: { role: 'assistant', content: text },
      })

      results.push({ workspace_id: row.workspace_id, status: 'sent' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[eod-summary] workspace ${row.workspace_id}:`, msg)
      results.push({ workspace_id: row.workspace_id, status: 'error', detail: msg })
    }
  }

  return NextResponse.json({ checked: results.length, results })
}

function pickTimezone(cust: WorkspaceRow['customers']): string {
  if (!cust) return 'America/Nassau'
  const tz = Array.isArray(cust) ? cust[0]?.timezone : cust.timezone
  return tz?.trim() || 'America/Nassau'
}

function shouldSkip(args: {
  nowISO: string
  targetTime: string
  lastSentAtISO: string | null
  timezone: string
  mutedUntilISO: string | null
}): string | null {
  const now = new Date(args.nowISO)
  if (args.mutedUntilISO) {
    const mutedUntil = new Date(args.mutedUntilISO)
    if (!Number.isNaN(mutedUntil.getTime()) && mutedUntil > now) return 'muted'
  }
  const targetHour = parseInt(args.targetTime.slice(0, 2), 10)
  const currentHour = hourInTimezone(now, args.timezone)
  if (currentHour !== targetHour) {
    return `not eod hour (now=${currentHour}, target=${targetHour})`
  }
  if (args.lastSentAtISO) {
    const lastSent = new Date(args.lastSentAtISO)
    if (
      !Number.isNaN(lastSent.getTime()) &&
      sameLocalDay(lastSent, now, args.timezone)
    ) {
      return 'already sent today'
    }
  }
  return null
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
