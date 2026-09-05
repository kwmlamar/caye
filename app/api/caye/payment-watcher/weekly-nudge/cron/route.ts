import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { recordCronRun } from '@/lib/cron-run-log'
import { raisePaymentWatcherWeeklyNudge } from '@/lib/payment-watcher/weekly-aging-nudge'

/**
 * GET /api/caye/payment-watcher/weekly-nudge/cron
 *
 * Friday-only: raises the aging digest (invoices over 30 days with nothing
 * recorded against them) into caye_owner_attention. Delivery to WhatsApp
 * rides the existing construction-ledger-cycle 30-minute delivery step
 * (lib/construction-attention-delivery.ts) — this route never sends anything
 * itself, it only raises.
 *
 * SHIPS DISABLED BY DEFAULT (PAYMENT_WATCHER_WEEKLY_NUDGE_ENABLED). At the
 * time this shipped, TropiTrack held 8 invoices — all stale imports,
 * totalling $94,178.46, that are almost certainly already paid (one client
 * confirmed wiring in August). Turning this on before the invoice ledger
 * reflects real work would fire a loudly wrong digest on day one, and a
 * nudge that's wrong the first time gets muted forever. Do not flip this
 * flag on without first confirming the invoice ledger is current — see
 * briefs/payment-watcher-email-signals.md.
 */

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = request.headers.get('authorization')
  const legacy = request.headers.get('x-cron-secret')
  return auth === `Bearer ${secret}` || legacy === secret
}

// ODS-specific fallback rather than a per-workspace timezone lookup — this
// ships disabled, and a fixed Bahamas timezone is enough to gate "is it
// Friday" correctly for the one workspace that matters today.
const FALLBACK_TIMEZONE = 'America/Nassau'

function isFridayInTimezone(now: Date, timezone: string): boolean {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(now) === 'Fri'
}

const BEDROCK = 'bedrock'

async function listBoundWorkspaces(): Promise<string[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('domain_source_connections')
    .select('workspace_id')
    .eq('source_system', BEDROCK)
    .eq('status', 'active')
  if (error) throw new Error(`could not list construction ledger connections — ${error.message}`)
  return (data ?? []).map((row) => row.workspace_id as string)
}

async function runWeeklyNudge() {
  const now = new Date()
  const workspaceIds = await listBoundWorkspaces()
  const results: Array<{ workspace_id: string; status: string; detail?: unknown }> = []

  for (const workspaceId of workspaceIds) {
    if (!isFridayInTimezone(now, FALLBACK_TIMEZONE)) {
      results.push({ workspace_id: workspaceId, status: 'skip', detail: 'not_friday' })
      continue
    }
    try {
      const result = await raisePaymentWatcherWeeklyNudge({ workspaceId })
      results.push({ workspace_id: workspaceId, status: 'ok', detail: result })
    } catch (err) {
      results.push({ workspace_id: workspaceId, status: 'error', detail: err instanceof Error ? err.message : String(err) })
    }
  }
  return { checked: results.length, results }
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (process.env.PAYMENT_WATCHER_WEEKLY_NUDGE_ENABLED !== 'true') {
    return NextResponse.json({ skipped: 'disabled_by_default' })
  }
  try {
    return NextResponse.json(await recordCronRun('payment-watcher-weekly-nudge', runWeeklyNudge))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
