import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { latestCayeDirectActivity } from '@/lib/caye-direct-activity'

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  const threadId = req.nextUrl.searchParams.get('threadId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const activity = await latestCayeDirectActivity(workspaceId, threadId)
  return NextResponse.json({ activity })
}
