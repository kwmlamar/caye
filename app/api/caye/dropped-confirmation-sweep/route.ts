/**
 * GET /api/caye/dropped-confirmation-sweep
 *
 * Silent observability backstop for staged actions that became stale without
 * executing.
 *
 * WHY THIS CHANGED (2026-08-18)
 * This endpoint used to WhatsApp operators whenever a pending authorization
 * aged out. That turned an internal safety TTL into a fake business deadline:
 * operators were told drafts had "expired" and were asked to race a 15-minute
 * clock even though the draft itself was perfectly valid.
 *
 * We still detect stale rows because they are useful reliability telemetry.
 * We do NOT notify the operator about the internal lifecycle. A late real
 * confirmation is handled by confirm_pending_action, which safely creates a
 * fresh confirmation checkpoint without executing the stale authorization.
 *
 * Secure via CRON_SECRET, matching stale-hold-sweep.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import {
  selectDroppedConfirmations,
  REPORT_WINDOW_HOURS,
  type PendingActionRow,
} from '@/lib/whatsapp/dropped-confirmations'

interface SweepSummary {
  candidates_scanned: number
  dropped_found: number
  silently_recorded: number
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
    candidates_scanned: 0,
    dropped_found: 0,
    silently_recorded: 0,
    errors: [],
  }

  const now = new Date()
  const windowStart = new Date(now.getTime() - REPORT_WINDOW_HOURS * 60 * 60 * 1000)

  // Keep the original detection semantics. Rows that were revised later are
  // not reliability drops; selectDroppedConfirmations handles that by looking
  // across every row in the window.
  const { data, error } = await supabase
    .from('caye_pending_actions')
    .select(
      'id, workspace_id, operator_id, tool_name, args, summary, created_at, expires_at, executed_at, cancelled_at, owner_handled_at, dropped_reported_at'
    )
    .gte('expires_at', windowStart.toISOString())
    .is('owner_handled_at', null)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[dropped-confirmation-sweep] lookup failed:', error.message)
    return NextResponse.json({ ...summary, errors: [error.message] }, { status: 500 })
  }

  const rows = (data ?? []) as (PendingActionRow & { workspace_id: string })[]
  summary.candidates_scanned = rows.length

  const byWorkspace = new Map<string, (PendingActionRow & { workspace_id: string })[]>()
  for (const row of rows) {
    const list = byWorkspace.get(row.workspace_id) ?? []
    list.push(row)
    byWorkspace.set(row.workspace_id, list)
  }

  for (const [workspaceId, workspaceRows] of byWorkspace) {
    try {
      const dropped = selectDroppedConfirmations({ rows: workspaceRows, now })
      if (!dropped.length) continue
      summary.dropped_found += dropped.length

      for (const item of dropped) {
        // This mark is now telemetry-only. It prevents the same stale row from
        // being rediscovered forever while preserving the audit trail. No
        // outbound message is enqueued here.
        const { error: markErr } = await supabase
          .from('caye_pending_actions')
          .update({ dropped_reported_at: new Date().toISOString() })
          .eq('id', item.id)

        if (markErr) {
          summary.errors.push(`mark ${item.id}: ${markErr.message}`)
          console.error('[dropped-confirmation-sweep] mark failed:', markErr.message)
          continue
        }

        summary.silently_recorded++
        console.warn(
          `[dropped-confirmation-sweep] stale pending action recorded silently workspace=${workspaceId} id=${item.id} tool=${item.toolName}`
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`workspace ${workspaceId}: ${msg}`)
      console.error(`[dropped-confirmation-sweep] workspace ${workspaceId} failed:`, err)
    }
  }

  console.log('[dropped-confirmation-sweep] complete', summary)
  return NextResponse.json(summary)
}
