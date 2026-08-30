import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = request.headers.get('authorization')
  const legacy = request.headers.get('x-cron-secret')
  return auth === `Bearer ${secret}` || legacy === secret
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('run_workspace_event_perception_cycle', {
    p_limit: 100,
  })

  if (error) {
    return NextResponse.json(
      { error: 'Perception cycle unavailable; scheduler will retry on the next run.' },
      { status: 500 },
    )
  }

  return NextResponse.json(data ?? { status: 'ok', processed: 0, changed: 0, unchanged: 0, failed: 0 })
}
