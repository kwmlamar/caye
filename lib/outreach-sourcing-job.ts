import 'server-only'
import { createServiceClient } from './supabase-server'
import { sourceLeads } from './outreach-sourcing'
import { OUTREACH_DAILY_SEND_CAP } from './outreach-send-limits'

const SOURCING_BATCH_SIZE = 20

export async function runOutreachSourcingJob(workspaceId: string): Promise<Record<string, unknown>> {
  const db = createServiceClient()
  const { count: unsentSupply, error: supplyErr } = await db.from('outreach_leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).is('first_touch_sent_at', null).is('opted_out_at', null)
  if (supplyErr) throw new Error(supplyErr.message)
  if ((unsentSupply ?? 0) >= OUTREACH_DAILY_SEND_CAP) return { status: 'skip', detail: `un-contacted supply (${unsentSupply}) already covers the daily cap (${OUTREACH_DAILY_SEND_CAP})` }
  const { data: target, error: targetErr } = await db.from('outreach_sourcing_targets').select('id, vertical, region').eq('active', true).order('priority').order('last_sourced_at', { ascending: true, nullsFirst: true }).limit(1).maybeSingle()
  if (targetErr) throw new Error(targetErr.message)
  if (!target) return { status: 'skip', detail: 'no active outreach_sourcing_targets' }
  const sourced = await sourceLeads(target.vertical, target.region, SOURCING_BATCH_SIZE)
  const withEmail = sourced.filter((lead) => lead.email)
  let inserted = 0
  if (withEmail.length) {
    const { data, error } = await db.from('outreach_leads').upsert(withEmail.map((lead) => ({ workspace_id: workspaceId, lead_email: lead.email!, business_name: lead.business_name, status: 'sourced' })), { onConflict: 'workspace_id,lead_email', ignoreDuplicates: true }).select('id')
    if (error) throw new Error(error.message)
    inserted = data?.length ?? 0
  }
  await db.from('outreach_sourcing_targets').update({ last_sourced_at: new Date().toISOString() }).eq('id', target.id)
  return { status: 'ok', target: `${target.vertical} — ${target.region}`, found: sourced.length, with_email: withEmail.length, rejected_no_email: sourced.length - withEmail.length, duplicates: withEmail.length - inserted, inserted }
}
