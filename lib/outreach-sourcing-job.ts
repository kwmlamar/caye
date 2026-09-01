import 'server-only'
import { createServiceClient } from './supabase-server'
import { sourceLeads } from './outreach-sourcing'
import { OUTREACH_DAILY_SEND_CAP } from './outreach-send-limits'
import { selectSourcingTargetsForRun, type SourcingTarget } from './outreach-sourcing-plan'

const SOURCING_BATCH_SIZE = 20

/**
 * Bounds how many active targets a single run will attempt (Places quota /
 * scrape cost), independent of the live early-stop below. Set to the full
 * seeded target count so a run can, in principle, walk every active target
 * in one pass when the buffer is far below the daily cap — see CAY-98:
 * sourcing only ever reaching one target per day was the reported
 * bottleneck.
 */
const MAX_TARGETS_PER_RUN = 10

type Db = ReturnType<typeof createServiceClient>

interface TargetRunResult {
  target: string
  target_id: string
  found: number
  with_email: number
  rejected_no_email: number
  duplicates: number
  inserted: number
  error?: string
}

export async function runOutreachSourcingJob(workspaceId: string): Promise<Record<string, unknown>> {
  const db = createServiceClient()

  let unsentSupply = await countUnsentEligibleSupply(db, workspaceId)
  if (unsentSupply >= OUTREACH_DAILY_SEND_CAP) {
    return {
      status: 'skip',
      detail: `un-contacted supply (${unsentSupply}) already covers the daily cap (${OUTREACH_DAILY_SEND_CAP})`,
      unsent_supply: unsentSupply,
    }
  }

  const { data: activeTargets, error: targetErr } = await db
    .from('outreach_sourcing_targets')
    .select('id, vertical, region, priority, last_sourced_at')
    .eq('active', true)
  if (targetErr) throw new Error(targetErr.message)
  if (!activeTargets || activeTargets.length === 0) {
    return { status: 'skip', detail: 'no active outreach_sourcing_targets', unsent_supply: unsentSupply }
  }

  const queue = selectSourcingTargetsForRun({
    targets: activeTargets as SourcingTarget[],
    startingUnsentSupply: unsentSupply,
    dailyCap: OUTREACH_DAILY_SEND_CAP,
    maxTargetsPerRun: MAX_TARGETS_PER_RUN,
  })

  const unsentSupplyStart = unsentSupply
  const targetsRun: TargetRunResult[] = []

  // Rotate through the queue until the buffer covers the daily cap or the
  // run's target budget is spent. Re-checking live supply between attempts
  // (rather than trusting the pure plan's yield-free preview) is what lets
  // one run replenish from several targets on a quiet day and stop early on
  // a productive one.
  for (const target of queue) {
    if (unsentSupply >= OUTREACH_DAILY_SEND_CAP) break
    const result = await sourceFromTarget(db, workspaceId, target)
    targetsRun.push(result)
    unsentSupply += result.inserted
  }

  // A per-target failure is isolated so the rest of the rotation still
  // runs (see sourceFromTarget), but if every attempted target failed —
  // e.g. GOOGLE_MAPS_API_KEY missing, or Places down — that is a real
  // system-level failure, not a quiet zero-insert day. Throwing here keeps
  // caye_cron_runs.last_status accurate for getOutreachOperationalStatus's
  // reasonNoOutreach, instead of reporting 'ok' while nothing worked.
  if (targetsRun.length > 0 && targetsRun.every((t) => t.error)) {
    throw new Error(`all ${targetsRun.length} sourcing targets failed: ${targetsRun.map((t) => `${t.target}: ${t.error}`).join('; ')}`)
  }

  return {
    status: 'ok',
    unsent_supply_start: unsentSupplyStart,
    unsent_supply_end: unsentSupply,
    targets_attempted: targetsRun.length,
    targets_run: targetsRun,
    total_found: sumBy(targetsRun, (t) => t.found),
    total_with_email: sumBy(targetsRun, (t) => t.with_email),
    total_rejected_no_email: sumBy(targetsRun, (t) => t.rejected_no_email),
    total_duplicates: sumBy(targetsRun, (t) => t.duplicates),
    total_inserted: sumBy(targetsRun, (t) => t.inserted),
  }
}

async function countUnsentEligibleSupply(db: Db, workspaceId: string): Promise<number> {
  const { count, error } = await db
    .from('outreach_leads')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .is('first_touch_sent_at', null)
    .is('opted_out_at', null)
  if (error) throw new Error(error.message)
  return count ?? 0
}

/**
 * One target's sourcing pass. A per-target failure (e.g. a transient Places
 * or scrape error) is recorded, not thrown — one bad target must not stop
 * the rest of the queue from replenishing the buffer, and `last_sourced_at`
 * is deliberately left untouched on failure so a failed target is retried
 * before its successful siblings on the next run rather than going to the
 * back of the rotation.
 */
async function sourceFromTarget(db: Db, workspaceId: string, target: SourcingTarget): Promise<TargetRunResult> {
  const label = `${target.vertical} — ${target.region}`
  try {
    const sourced = await sourceLeads(target.vertical, target.region, SOURCING_BATCH_SIZE)
    const withEmail = sourced.filter((lead) => lead.email)
    let inserted = 0
    if (withEmail.length) {
      const { data, error } = await db
        .from('outreach_leads')
        .upsert(
          withEmail.map((lead) => ({
            workspace_id: workspaceId,
            lead_email: lead.email!,
            business_name: lead.business_name,
            business_evidence: lead.evidence,
            status: 'sourced',
          })),
          { onConflict: 'workspace_id,lead_email', ignoreDuplicates: true }
        )
        .select('id')
      if (error) throw new Error(error.message)
      inserted = data?.length ?? 0
    }
    await db.from('outreach_sourcing_targets').update({ last_sourced_at: new Date().toISOString() }).eq('id', target.id)
    return {
      target: label,
      target_id: target.id,
      found: sourced.length,
      with_email: withEmail.length,
      rejected_no_email: sourced.length - withEmail.length,
      duplicates: withEmail.length - inserted,
      inserted,
    }
  } catch (err) {
    return {
      target: label,
      target_id: target.id,
      found: 0,
      with_email: 0,
      rejected_no_email: 0,
      duplicates: 0,
      inserted: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function sumBy<T>(items: T[], fn: (item: T) => number): number {
  return items.reduce((sum, item) => sum + fn(item), 0)
}
