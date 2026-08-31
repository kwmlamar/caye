import { NextRequest, NextResponse } from 'next/server'
import { runStandingAutonomyCycle } from '@/lib/job-search/execution/autonomy'

/**
 * The autonomous application worker.
 *
 * This is what makes standing authorization mean something operationally: the
 * founder should not have to send a chat message per application, so the
 * qualified queue is consumed on a schedule instead. It is a thin entry point —
 * every decision, cap, and kill switch lives in lib/job-search, so the cron and
 * a manual trigger behave identically.
 *
 * Idle is the normal, expected outcome. With no standing authorization, a
 * pause, an exhausted cap, or an empty qualified queue, this returns idle and
 * does nothing at all.
 */
export const maxDuration = 300

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

  try {
    return NextResponse.json(await runStandingAutonomyCycle())
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
