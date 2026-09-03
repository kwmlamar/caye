import 'server-only'
import { sourceLeads, getQueryVariants, advanceSourcingCursor, type SourcedLead } from './outreach-sourcing'
import { createServiceClient } from './supabase-server'
import { OUTREACH_DAILY_SEND_CAP } from './outreach-send-limits'
import { selectSourcingTargetsForRun, type SourcingTarget } from './outreach-sourcing-plan'

const SOURCING_BATCH_SIZE = 20
const MAX_TARGETS_PER_RUN = 10
type Db = ReturnType<typeof createServiceClient>
/** `outreach_sourcing_targets` row plus the per-target sourcing cursor added in supabase/migrations/20260903100000_outreach_sourcing_coverage.sql. Kept separate from `SourcingTarget` (outreach-sourcing-plan.ts) because that type only needs the fields relevant to run-ordering, not to within-target pagination. */
type SourcingTargetRow = SourcingTarget & { query_variant_index: number; result_offset: number }
interface TargetRunResult { target: string; target_id: string; found: number; with_email: number; rejected_no_email: number; rejected_not_icp: number; rejected_shared_domain: number; duplicates: number; inserted: number; error?: string }

/**
 * Free-mail providers exempt from MAX_LEADS_PER_SHARED_DOMAIN below — an
 * independent Caribbean SMB legitimately running its business off a
 * personal Gmail/Yahoo/etc. address is common, and capping those would
 * penalize genuine SMBs for using the same popular provider as everyone
 * else, which is the opposite of the corporate-mailbox signal this exists
 * to catch.
 */
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com',
  'aol.com',
  'mail.com', 'protonmail.com',
])

/** Pure — the domain half of an email address, lowercased. Returns null for a malformed address with no (non-trailing) '@'. */
export function extractEmailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at === -1 || at === email.length - 1) return null
  return email.slice(at + 1).toLowerCase()
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.toLowerCase())
}

/**
 * A workspace already having this many leads on one non-free-mail email
 * domain is treated as "this is a corporate/hospitality-group mailbox,
 * not N independent SMBs" rather than N distinct businesses to keep
 * chasing — real evidence (2026-09-03), not a guess: Solemar, Meze Grill,
 * and Latitudes are three separately-sourced "businesses" that all mail
 * through titan.bs, a shared hospitality-group domain; all three were bad
 * leads/opt-outs, and a single shared mail gateway on that domain also
 * produced the phantom demo-link clicks that briefly looked like real
 * engagement. Atlantis Paradise Island is the same shape at n=1 (a named
 * individual, Jack.Edelman@atlantisparadise.com, at a dedicated resort
 * domain) but is already caught by the review-volume filter above; the
 * domain cap is what catches the group case that review count cannot.
 *
 * Capped at 2 rather than 1: lets two leads on a coincidentally-shared
 * domain through (e.g. a small regional web host issuing addresses for
 * unrelated small businesses) before treating further leads on that same
 * domain as the group pattern, rather than rejecting on the very first
 * collision.
 */
export const MAX_LEADS_PER_SHARED_DOMAIN = 2

async function countLeadsByDomain(db: Db, workspaceId: string, domain: string): Promise<number> {
  const { count, error } = await db.from('outreach_leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).ilike('lead_email', `%@${domain}`)
  if (error) throw new Error(error.message)
  return count ?? 0
}

/**
 * Filters a batch of leads-with-email down to the ones that stay under
 * MAX_LEADS_PER_SHARED_DOMAIN, counting both what's already in the
 * database for a domain and what this same batch has already accepted
 * for it (so three same-run leads on one shared domain can't all sneak
 * past a DB count taken before any of them existed).
 */
async function applySharedDomainCap(db: Db, workspaceId: string, leads: SourcedLead[]): Promise<{ accepted: SourcedLead[]; rejectedSharedDomain: number }> {
  const domainCounts = new Map<string, number>()
  const accepted: SourcedLead[] = []
  let rejectedSharedDomain = 0
  for (const lead of leads) {
    const domain = lead.email ? extractEmailDomain(lead.email) : null
    if (!domain || isFreeMailDomain(domain)) { accepted.push(lead); continue }
    if (!domainCounts.has(domain)) domainCounts.set(domain, await countLeadsByDomain(db, workspaceId, domain))
    const current = domainCounts.get(domain)!
    if (current >= MAX_LEADS_PER_SHARED_DOMAIN) { rejectedSharedDomain++; continue }
    domainCounts.set(domain, current + 1)
    accepted.push(lead)
  }
  return { accepted, rejectedSharedDomain }
}

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
  return { status: 'ok', unsent_supply_start: unsentSupplyStart, unsent_supply_end: unsentSupply, targets_attempted: targetsRun.length, targets_run: targetsRun, total_found: sumBy(targetsRun, (t) => t.found), total_with_email: sumBy(targetsRun, (t) => t.with_email), total_rejected_no_email: sumBy(targetsRun, (t) => t.rejected_no_email), total_rejected_not_icp: sumBy(targetsRun, (t) => t.rejected_not_icp), total_rejected_shared_domain: sumBy(targetsRun, (t) => t.rejected_shared_domain), total_duplicates: sumBy(targetsRun, (t) => t.duplicates), total_inserted: sumBy(targetsRun, (t) => t.inserted) }
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
    const withEmail = sourced.leads.filter((lead) => lead.email)
    const { accepted, rejectedSharedDomain } = await applySharedDomainCap(db, workspaceId, withEmail)
    let inserted = 0
    if (accepted.length) {
      const { data, error } = await db.from('outreach_leads').upsert(accepted.map((lead) => ({ workspace_id: workspaceId, lead_email: lead.email!, business_name: lead.business_name, business_evidence: lead.evidence, outreach_vertical: target.vertical, status: 'sourced' })), { onConflict: 'workspace_id,lead_email', ignoreDuplicates: true }).select('id')
      if (error) throw new Error(error.message); inserted = data?.length ?? 0
    }
    const nextCursor = advanceSourcingCursor({ cursor: { queryVariantIndex: variantIndex, resultOffset: target.result_offset }, variantsCount: variants.length, resultsConsumedInThisPage: sourced.consumed, totalResultsForVariant: sourced.totalResults })
    await db.from('outreach_sourcing_targets').update({ last_sourced_at: new Date().toISOString(), query_variant_index: nextCursor.queryVariantIndex, result_offset: nextCursor.resultOffset }).eq('id', target.id)
    return { target: label, target_id: target.id, found: sourced.leads.length + sourced.rejectedNotIcp, with_email: withEmail.length, rejected_no_email: sourced.leads.length - withEmail.length, rejected_not_icp: sourced.rejectedNotIcp, rejected_shared_domain: rejectedSharedDomain, duplicates: accepted.length - inserted, inserted }
  } catch (err) { return { target: label, target_id: target.id, found: 0, with_email: 0, rejected_no_email: 0, rejected_not_icp: 0, rejected_shared_domain: 0, duplicates: 0, inserted: 0, error: err instanceof Error ? err.message : String(err) } }
}
function sumBy<T>(items: T[], fn: (item: T) => number): number { return items.reduce((sum, item) => sum + fn(item), 0) }
