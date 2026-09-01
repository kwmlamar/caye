import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { createServiceClient } from '@/lib/supabase-server'
import { listWorkspaceDirectRuns, founderRunLabel } from '@/lib/caye-direct-runs'

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId required' }, { status: 400 })
  const runs = await listWorkspaceDirectRuns(createServiceClient(), workspaceId)
  return NextResponse.json({ runs: runs.map((run) => ({
    id: run.id, thread_id: run.thread_id, status: run.status, objective: run.objective,
    label: founderRunLabel(run), started_at: run.started_at, updated_at: run.updated_at,
    control_requested: run.control_requested,
  })) })
}
