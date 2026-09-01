import { NextRequest, NextResponse } from 'next/server'
import { runFollowupSweep } from '@/lib/job-search/followup-scheduler'

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
    const stats = await runJobSearchFollowupSweep()
    return NextResponse.json({ status: 'completed', stats })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function runJobSearchFollowupSweep(): Promise<Record<string, unknown>> {
  const stats = await runFollowupSweep()
  return { ...stats }
}
