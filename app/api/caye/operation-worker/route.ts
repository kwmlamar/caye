/**
 * GET /api/caye/operation-worker
 *
 * Drains caye_pending_operations — the durable outbox for external side
 * effects (Zoho Calendar today) whose first attempt failed transiently.
 *
 * The drain itself lives in lib/pending-operations-worker.ts because the
 * outbound worker also calls it on its ~1min tick, so retries work without
 * anyone registering this endpoint anywhere. This route exists for manual
 * and admin-shell triggering, and so the job reports its own cron health.
 *
 * Secured by CRON_SECRET, matching /api/caye/outbound-worker.
 */

import { NextRequest, NextResponse } from 'next/server'
import { drainPendingOperations } from '@/lib/pending-operations-worker'
import { recordCronRun } from '@/lib/cron-run-log'

export async function runOperationWorker(): Promise<Record<string, unknown>> {
  return recordCronRun('operation-worker', async () => drainPendingOperations())
}

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
    return NextResponse.json(await runOperationWorker())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[operation-worker] tick failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
