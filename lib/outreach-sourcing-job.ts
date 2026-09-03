import 'server-only'
import { createServiceClient } from './supabase-server'
import { sourceLeads, getQueryVariants, advanceSourcingCursor } from './outreach-sourcing'
import { OUTREACH_DAILY_SEND_CAP } from './outreach-send-limits'
import { selectSourcingTargetsForRun, type SourcingTarget } from './outreach-sourcing-plan'

const SOURCING_BATCH_SIZE = 20
const MAX_TARGETS_PER_RUN = 10
type Db = ReturnType<typeof createServiceClient>
/** `outreach_sourcing_targets` row plus the per-target sourcing cursor added in supabase/migrations/20260903100000_outreach_sourcing_coverage.sql. Kept separate from `SourcingTarget` (outreach-sourcing-plan.ts) because that type only needs the fields relevant to run-ordering, not to within-target pagination. */
type SourcingTargetRow = SourcingTarget & { query_variant_index: number; result_offset: number }
interface TargetRunResult { target: string; target_id: string; found: number; with_email: number; rejected_no_email: number; rejected_not_icp: number; duplicates: number; inserted: number; error?: string }

export async function runOutreachSourcingJob(workspaceId: string): Promise<Record<string, unknown>> {
  const db = createServiceClient()
  let unsentSupply = await countUnsentEligibleSupply(db, workspaceId)
  if (unsentSupply >= OUTREACH_DAILY_SEND_CAP) return { status: 'skip', detail: `un-contacted supply (${unsentSupply}) already covers the daily cap (${OUTREACH_DAILY_SEND_CAP})`, unsent_supply: unsentSupply }
  const { data: activeTargets, error: targetErr } = await db.from('outreach_sourcing_targets').select('id, vertical, region, priority, last_sourced_at, query_variant_index, result_offset').eq('active', true)
  if (targetErr) throw new Error(targetErr.message)
  if (!activeTargets || activeTargets.length === 0) return { status: 'skip', detail: 'no active outreach_sourcing_targets', unsent_supply: unsentSupply }
  const queue = selectSourcingTargetsForRun({ targets: activeTargets as SourcingTargetRow[], startingUnsentSupply: unsentSupply, dailyCap: OUTREACH_DAILY_SEND_CAP, maxTargetsPerRun: MAX_TARGETS_PER_RUN })
  const unsentSupplyStart = unsentSupply
  const targetsRun: TargetRunResult[] = []
  for (const target of queue) { if (unsentSupply >= OUTREACH_DAILY_SEND_CAP) break; const result = await sourceFromTarget(db, workspaceId, target as SourcingTargetRow); targetsRun.push(result); unsentSupply += result.inserted }
  if (targetsRun.length > 0 && targetsRun.every((t) => t.error)) throw new Error(`all ${targetsRun.length} sourcing targets failed: ${targetsRun.map((t) => `${t.target}: ${t.error}`).join('; ')}`)
  return { status: 'ok', unsent_supply_start: unsentSupplyStart, unsent_supply_end: unsentSupply, targets_attempted: targetsRun.length, targets_run: targetsRun, total_found: sumBy(targetsRun, (t) => t.found), total_with_email: sumBy(targetsRun, (t) => t.with_email), total_rejected_no_email: sumBy(targetsRun, (t) => t.rejected_no_email), total_rejected_not_icp: sumBy(targetsRun, (t) => t.rejected_not_icp), total_duplicates: sumBy(targetsRun, (t) => t.duplicates), total_inserted: sumBy(targetsRun, (t) => t.inserted) }
}
async function countUnsentEligibleSupply(db: Db, workspaceId: string): Promise<number> {
  const { count, error } = await db.from('outreach_leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).is('first_touch_sent_at', null).is('opted_out_at', null)
  if (error) throw new Error(error.message); return count ?? 0
}
async function sourceFromTarget(db: Db, workspaceId: string, target: SourcingTargetRow): Promise<TargetRunResult> {
  const label = `${target.vertical} — ${target.region}`
  const variants = getQueryVariants(target.vertical)
  // Defensive modulo: guards against a stale index if VERTICAL_QUERY_VARIANTS
  // for this vertical ever shrinks between deploys.
  const variantIndex = ((target.query_variant_index % variants.length) + variants.length) % variants.length
  const queryVariant = variants[variantIndex]
  try {
    const sourced = await sourceLeads(queryVariant, target.region, SOURCING_BATCH_SIZE, target.result_offset)
    const withEmail = sourced.leads.filter((lead) => lead.email); let inserted = 0
    if (withEmail.length) {
      const { data, error } = await db.from('outreach_leads').upsert(withEmail.map((lead) => ({ workspace_id: workspaceId, lead_email: lead.email!, business_name: lead.business_name, business_evidence: lead.evidence, outreach_vertical: target.vertical, status: 'sourced' })), { onConflict: 'workspace_id,lead_email', ignoreDuplicates: true }).select('id')
      if (error) throw new Error(error.message); inserted = data?.length ?? 0
    }
    const nextCursor = advanceSourcingCursor({ cursor: { queryVariantIndex: variantIndex, resultOffset: target.result_offset }, variantsCount: variants.length, resultsConsumedInThisPage: sourced.consumed, totalResultsForVariant: sourced.totalResults })
    await db.from('outreach_sourcing_targets').update({ last_sourced_at: new Date().toISOString(), query_variant_index: nextCursor.queryVariantIndex, result_offset: nextCursor.resultOffset }).eq('id', target.id)
    return { target: label, target_id: target.id, found: sourced.leads.length + sourced.rejectedNotIcp, with_email: withEmail.length, rejected_no_email: sourced.leads.length - withEmail.length, rejected_not_icp: sourced.rejectedNotIcp, duplicates: withEmail.length - inserted, inserted }
  } catch (err) { return { target: label, target_id: target.id, found: 0, with_email: 0, rejected_no_email: 0, rejected_not_icp: 0, duplicates: 0, inserted: 0, error: err instanceof Error ? err.message : String(err) } }
}
function sumBy<T>(items: T[], fn: (item: T) => number): number { return items.reduce((sum, item) => sum + fn(item), 0) }
