/**
 * GET /api/calendar/poll-zoho
 *
 * Cron endpoint — pulls each workspace's Zoho Calendar events into the
 * bookings table. Mirrors the auth pattern of /api/email/poll (x-cron-secret
 * header or Authorization: Bearer <CRON_SECRET>).
 *
 * Schedule via cron-job.org every 5–10 minutes. Each workspace with an active
 * Zoho email account AND sync_calendar=true is polled in serial; failures on
 * one workspace don't block the others.
 *
 * Returns a summary so the cron service log shows what happened.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { syncZohoEventsToBookings, type InboundSyncStats } from '@/lib/zoho-inbound-sync'

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const provided =
      req.headers.get('x-cron-secret') ||
      req.headers.get('authorization')?.replace('Bearer ', '')
    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const supabase = createServiceClient()

  const { data: accounts, error } = await supabase
    .from('connected_accounts')
    .select('user_id')
    .eq('channel_type', 'email')
    .eq('is_active', true)
    .eq('sync_calendar', true)

  if (error) {
    console.error('[poll-zoho] Failed to load accounts:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!accounts || accounts.length === 0) {
    return NextResponse.json({ workspaces: 0, results: [] })
  }

  const seen = new Set<string>()
  const results: InboundSyncStats[] = []

  for (const row of accounts) {
    const workspaceId = row.user_id as string
    if (seen.has(workspaceId)) continue
    seen.add(workspaceId)

    try {
      const stats = await syncZohoEventsToBookings(workspaceId)
      results.push(stats)
      if (stats.error) {
        console.warn(`[poll-zoho] ${workspaceId}: ${stats.error}`)
      } else {
        console.log(
          `[poll-zoho] ${workspaceId}: fetched=${stats.fetched} ` +
            `inserted=${stats.inserted} updated=${stats.updated} ` +
            `linked=${stats.linked} cancelled=${stats.cancelled} skipped=${stats.skipped}`
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[poll-zoho] ${workspaceId} crashed:`, msg)
      results.push({
        workspaceId,
        fetched: 0,
        inserted: 0,
        updated: 0,
        linked: 0,
        cancelled: 0,
        skipped: 0,
        error: msg,
      })
    }
  }

  return NextResponse.json({ workspaces: results.length, results })
}
