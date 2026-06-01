/**
 * POST /api/caye/catch-up
 *
 * "Catch me up." Caye reads the last N days of inbox activity and reports
 * back in a narrative + bulleted item list. The first-day-on-the-job moment.
 *
 * Body: { workspaceId: string, days?: number }
 * Returns: CatchUpResult
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient, createServiceClient } from '@/lib/supabase-server'
import { generateCatchUp } from '@/lib/catch-up-welcome'

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userClient = createServerClient(token)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { workspaceId?: string; days?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const workspaceId = body.workspaceId
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  }

  const supabase = createServiceClient()

  if (user.id !== workspaceId) {
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const days = typeof body.days === 'number' ? body.days : 5

  try {
    const result = await generateCatchUp(workspaceId, days)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[api/caye/catch-up] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Catch-up failed' },
      { status: 500 }
    )
  }
}
