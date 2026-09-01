import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return process.env.NODE_ENV !== 'production'
  return request.headers.get('x-cron-secret') === secret || request.headers.get('authorization') === `Bearer ${secret}`
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
  const since = typeof body.since === 'string' ? body.since : new Date(Date.now() - 30 * 86400000).toISOString()
  const dryRun = body.dryRun !== false
  const limit = typeof body.limit === 'number' ? Math.max(1, Math.min(body.limit, 5000)) : 500
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('enqueue_business_learning_backfill', {
    p_workspace_id: workspaceId,
    p_since: since,
    p_limit: limit,
    p_dry_run: dryRun,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = data ?? []
  return NextResponse.json({
    ok: true,
    dryRun,
    workspaceId,
    since,
    examined: rows.length,
    wouldEnqueue: rows.filter((row: { would_enqueue?: boolean }) => row.would_enqueue).length,
    rows,
  })
}
