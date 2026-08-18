/**
 * GET /api/caye/dropped-confirmation-sweep
 *
 * Detects staged actions that expired unexecuted, but keeps that lifecycle
 * internal. Expiration is an implementation/safety detail, not an operator
 * event. Operators should never receive database/TTL obituaries such as
 * "something I lined up expired".
 *
 * The sweep remains valuable as reliability telemetry: it records that a
 * dropped confirmation was observed so engineering can investigate recurring
 * failures without repeatedly reprocessing the same row.
 *
 * Secure via CRON_SECRET, matching the other Caye sweeps.
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
  marked_reported: number
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
    marked_reported: 0,
    errors: [],
  }

  const now = new Date()
  const windowStart = new Date(now.getTime() - REPORT_WINDOW_HOURS * 60 * 60 * 1000)

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

  // Supersede detection is scoped per workspace so one tenant can never
  // influence another tenant's dropped-action telemetry.
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
        console.warn('[dropped-confirmation-sweep] dropped confirmation detected', {
          workspaceId,
          pendingActionId: item.id,
          operatorId: item.operatorId,
          toolName: item.toolName,
        })

        const { error: markErr } = await supabase
          .from('caye_pending_actions')
          .update({ dropped_reported_at: new Date().toISOString() })
          .eq('id', item.id)

        if (markErr) {
          summary.errors.push(`mark ${item.id}: ${markErr.message}`)
          console.error('[dropped-confirmation-sweep] mark failed:', markErr.message)
          continue
        }

        summary.marked_reported++
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
