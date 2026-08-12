/**
 * GET /api/caye/outreach-sourcing-scan
 *
 * Daily cron — autonomous lead sourcing for the internal_sales workspace
 * (decisions-log 2026-08-12). Works through outreach_sourcing_targets (a
 * fixed vertical x region list — see the 20260812_outreach_autonomy.sql
 * migration comment) in priority order, least-recently-sourced first.
 * Deliberately does not let the model pick its own query/location — Caye
 * can propose a new target in conversation, she doesn't add one herself.
 *
 * Cost-aware: only calls the paid Places API when today's un-contacted
 * lead supply is below OUTREACH_DAILY_SEND_CAP — no point sourcing leads
 * that would just sit unused behind the volume cap.
 *
 * Authenticated via CRON_SECRET. Accepts either `x-cron-secret: <secret>`
 * or `Authorization: Bearer <secret>` (matches every other cron in this
 * repo). Registered on cron-job.org via scripts/register-outreach-crons.ts.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { recordCronRun } from '@/lib/cron-run-log'
import { sourceLeads } from '@/lib/outreach-sourcing'
import { OUTREACH_DAILY_SEND_CAP } from '@/lib/outreach-send-limits'

const SOURCING_BATCH_SIZE = 20

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const summary = await recordCronRun('outreach-sourcing-scan', async () => {
      const supabase = createServiceClient()

      const { data: workspace, error: wsErr } = await supabase
        .from('customers')
        .select('id')
        .eq('workspace_kind', 'internal_sales')
        .maybeSingle()
      if (wsErr) throw new Error(wsErr.message)
      if (!workspace) return { status: 'skip', detail: 'no internal_sales workspace found' }

      const { count: unsentSupply, error: supplyErr } = await supabase
        .from('outreach_leads')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id)
        .is('first_touch_sent_at', null)
        .is('opted_out_at', null)
      if (supplyErr) throw new Error(supplyErr.message)

      if ((unsentSupply ?? 0) >= OUTREACH_DAILY_SEND_CAP) {
        return {
          status: 'skip',
          detail: `un-contacted supply (${unsentSupply}) already covers the daily cap (${OUTREACH_DAILY_SEND_CAP})`,
        }
      }

      const { data: target, error: targetErr } = await supabase
        .from('outreach_sourcing_targets')
        .select('id, vertical, region')
        .eq('active', true)
        .order('priority', { ascending: true })
        .order('last_sourced_at', { ascending: true, nullsFirst: true })
        .limit(1)
        .maybeSingle()
      if (targetErr) throw new Error(targetErr.message)
      if (!target) {
        return { status: 'skip', detail: 'no active outreach_sourcing_targets — ask a founder to add one' }
      }

      const sourced = await sourceLeads(target.vertical, target.region, SOURCING_BATCH_SIZE)
      const withEmail = sourced.filter((l) => l.email)

      let inserted = 0
      if (withEmail.length > 0) {
        const { data: insertedRows, error: insertErr } = await supabase
          .from('outreach_leads')
          .upsert(
            withEmail.map((l) => ({
              workspace_id: workspace.id,
              lead_email: l.email!,
              business_name: l.business_name,
              status: 'sourced',
            })),
            { onConflict: 'workspace_id,lead_email', ignoreDuplicates: true }
          )
          .select('id')
        if (insertErr) throw new Error(insertErr.message)
        inserted = insertedRows?.length ?? 0
      }

      await supabase
        .from('outreach_sourcing_targets')
        .update({ last_sourced_at: new Date().toISOString() })
        .eq('id', target.id)

      return {
        status: 'ok',
        target: `${target.vertical} — ${target.region}`,
        found: sourced.length,
        with_email: withEmail.length,
        inserted,
      }
    })
    return NextResponse.json(summary)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
