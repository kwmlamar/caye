/**
 * GET /api/caye/morning-digest
 *
 * Hourly cron — fires the per-workspace morning digest when the workspace's
 * local time is 7am. Idempotent on the day: a duplicate enqueue is silently
 * rejected by the unique key on caye_outbound_queue.idempotency_key.
 *
 * Skips the digest entirely when there's nothing held + no same-day bookings.
 *
 * Secured by CRON_SECRET via x-cron-secret header.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOutbound } from '@/lib/whatsapp/outbound'
import { loadScheduleConfig, isDigestHour } from '@/lib/whatsapp/schedule'

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

    await enqueueOutbound({
      workspaceId: ws.workspace_id,
      kind: 'morning_digest',
      payload: {
        firstName,
        heldCount: held,
        bookingsTodayCount: bookings,
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
