/**
 * GET /api/caye/dropped-confirmation-sweep
 *
 * Tells an operator when something Caye staged for them died without going out.
 *
 * WHY THIS EXISTS (2026-08-11)
 * See lib/whatsapp/dropped-confirmations.ts for the full trace. Short version:
 * Caye staged a reply to Valencia Wills, asked Mrs. Max to confirm, she
 * answered "yes", and the turn vanished — no model call, no send, no error.
 * The staged row expired 14 minutes later. Nothing noticed, and she had no
 * reason to think the email hadn't gone.
 *
 * This is the backstop for that whole class of failure rather than for the one
 * cause. Three different bugs have now lost a confirmation (args-mismatch
 * restaging, classifier/agent routing, and this), each fixed at its own site
 * and each invisible until someone read the transcript. A staged action that
 * expires unexecuted is the common symptom, and it is cheap to watch for.
 *
 * DELIBERATELY NOISE-AVERSE. An operator revising a draft leaves expired rows
 * behind constantly — that is the normal path, not a fault. Only rows with no
 * later staging for the same thread are reported, which on the afternoon this
 * was written meant 1 ping out of 5 expired rows. An alert that cries wolf on
 * the other 4 would be turned off inside a week, and then the real one is lost
 * too.
 *
 * Never touches the staged action itself. It does not re-send, re-stage, or
 * execute anything — the operator is told, and they decide. Re-sending an
 * email the owner may have already handled by hand is exactly the kind of
 * autonomy this system does not take.
 *
 * Secure via CRON_SECRET, matching stale-hold-sweep.
 * Recommended cadence: every 5 minutes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOutbound } from '@/lib/whatsapp/outbound'
import { loadScheduleConfig } from '@/lib/whatsapp/schedule'
import {
  selectDroppedConfirmations,
  formatDroppedConfirmation,
  REPORT_WINDOW_HOURS,
  type PendingActionRow,
} from '@/lib/whatsapp/dropped-confirmations'

interface SweepSummary {
  candidates_scanned: number
  dropped_found: number
  pings_enqueued: number
  pings_skipped_no_phone: number
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
    pings_enqueued: 0,
    pings_skipped_no_phone: 0,
    errors: [],
  }

  const now = new Date()
  const windowStart = new Date(now.getTime() - REPORT_WINDOW_HOURS * 60 * 60 * 1000)

  // Every row in the window, not just the unexecuted ones: the supersede check
  // needs to see the send that DID go out, otherwise each revised draft looks
  // like an independent drop and the operator gets a ping per edit.
  const { data, error } = await supabase
    .from('caye_pending_actions')
    .select(
      'id, workspace_id, operator_id, tool_name, args, summary, created_at, expires_at, executed_at, cancelled_at, dropped_reported_at'
    )
    .gte('expires_at', windowStart.toISOString())
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[dropped-confirmation-sweep] lookup failed:', error.message)
    return NextResponse.json({ ...summary, errors: [error.message] }, { status: 500 })
  }

  const rows = (data ?? []) as (PendingActionRow & { workspace_id: string })[]
  summary.candidates_scanned = rows.length

  // Supersede is per-operator and per-thread, and both are scoped inside a
  // workspace, so group before deciding rather than comparing across tenants.
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

      const { timezone } = await loadScheduleConfig(workspaceId)

      for (const item of dropped) {
        // Back to the operator who was asked to confirm, not the workspace's
        // canonical number — staff and founders stage their own actions.
        let phone: string | null = null
        if (item.operatorId != null) {
          const { data: op } = await supabase
            .from('operator_allowlist')
            .select('phone')
            .eq('id', item.operatorId)
            .maybeSingle()
          phone = (op as { phone: string } | null)?.phone ?? null
        }
        if (!phone) {
          summary.pings_skipped_no_phone++
          console.warn(
            `[dropped-confirmation-sweep] no phone for operator ${item.operatorId} on ${workspaceId}; not pinging`
          )
          continue
        }

        const queued = await enqueueOutbound({
          workspaceId,
          kind: 'dropped_confirmation',
          payload: {
            body: formatDroppedConfirmation(item, timezone),
            to_phone: phone,
            pending_action_id: item.id,
            tool_name: item.toolName,
          },
          // One ping per dead action, ever.
          idempotencyKey: `dropped-confirmation-${item.id}`,
        })

        // Mark reported either way. A paused workspace returns null from
        // enqueueOutbound, and re-evaluating it on the next tick would just
        // re-suppress it — leaving it unmarked would make this row a
        // permanent candidate that gets rechecked every 5 minutes for a day.
        const { error: markErr } = await supabase
          .from('caye_pending_actions')
          .update({ dropped_reported_at: new Date().toISOString() })
          .eq('id', item.id)
        if (markErr) {
          summary.errors.push(`mark ${item.id}: ${markErr.message}`)
          console.error('[dropped-confirmation-sweep] mark failed:', markErr.message)
        }

        if (queued) summary.pings_enqueued++
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
