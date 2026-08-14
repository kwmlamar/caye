/**
 * GET /api/caye/outreach-sourcing-scan
 *
 * Daily cron — claims a durable autonomous sourcing operation for the
 * internal_sales workspace and returns immediately. The existing outbound
 * worker performs the slow Places and website work, records its result, and
 * prevents scheduler retries from duplicating the daily operation.
 *
 * Authenticated via CRON_SECRET. Accepts either `x-cron-secret: <secret>`
 * or `Authorization: Bearer <secret>` (matches every other cron in this
 * repo). Registered on cron-job.org via scripts/register-outreach-crons.ts.
 */
import { after, NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOperation } from '@/lib/pending-operations'
import { drainPendingOperationsSafely } from '@/lib/pending-operations-worker'

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
    const supabase = createServiceClient()
    const { data: workspace, error: wsErr } = await supabase
      .from('customers')
      .select('id')
      .eq('workspace_kind', 'internal_sales')
      .maybeSingle()
    if (wsErr) throw new Error(wsErr.message)
    if (!workspace) return NextResponse.json({ status: 'skip', detail: 'no internal_sales workspace found' })
    const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date())
    const queued = await enqueueOperation({ workspaceId: workspace.id, operation: 'outreach_sourcing', payload: { business_date: businessDate }, idempotencyKey: `outreach-sourcing:${workspace.id}:${businessDate}`, delayMs: 0 })
    if (!queued.queued) return NextResponse.json({ error: queued.reason ?? 'could not enqueue sourcing' }, { status: 500 })
    after(drainPendingOperationsSafely(1))
    return NextResponse.json({ status: 'accepted', already_queued: queued.alreadyQueued, workspace_id: workspace.id }, { status: 202 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
