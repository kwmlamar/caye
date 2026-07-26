/**
 * GET /api/caye/coding-session-poll
 *
 * Cron tick (~30s-1min via cron-job.org, same convention as
 * outbound-worker) — advances every active caye_coding_sessions row by one
 * poll tick (lib/coding-session/poll.ts): pulls new sandbox output,
 * persists message rows, and once the Claude Code CLI process exits, runs
 * the test/build gate and pushes (or reports failure).
 *
 * Secured by CRON_SECRET, same header convention as outbound-worker.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getActiveCodingSessionIds } from '@/lib/coding-session/queries'
import { pollCodingSession } from '@/lib/coding-session/poll'

export const maxDuration = 60

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const ids = await getActiveCodingSessionIds()
  const results = await Promise.allSettled(ids.map((id) => pollCodingSession(id)))

  const failures = results
    .map((r, i) => ({ r, id: ids[i] }))
    .filter(({ r }) => r.status === 'rejected')
    .map(({ r, id }) => ({ id, error: (r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason) }))

  if (failures.length > 0) {
    console.error('[coding-session-poll] tick errors:', failures)
  }

  return NextResponse.json({ polled: ids.length, failures })
}
