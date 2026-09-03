import { NextRequest, NextResponse } from 'next/server'
import { runConstructionLedgerCycle } from '@/lib/construction-ledger-cycle'

/**
 * Polls every workspace bound to a construction ledger and raises owner
 * attention for what changed. Read-only against the source system throughout:
 * the provider exposes no mutation and the adapter has no write methods.
 *
 * Registered in vercel.json. See lib/construction-ledger-cycle.ts for why the
 * sync and the attention projection are one ordered pass rather than two
 * independent crons.
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
    const result = await runConstructionLedgerCycle()
    return NextResponse.json(result)
  } catch (error) {
    // Listing the bound workspaces is the only failure that reaches here —
    // per-workspace errors are captured in the result rather than thrown.
    return NextResponse.json(
      {
        error: 'Construction ledger cycle unavailable; scheduler will retry on the next run.',
        detail: error instanceof Error ? error.message : 'unknown error',
      },
      { status: 500 },
    )
  }
}
