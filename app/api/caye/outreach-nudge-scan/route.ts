/**
 * GET /api/caye/outreach-nudge-scan
 *
 * Daily cron — step 2 of the outreach autonomy roadmap (decisions-log
 * 2026-07-21): for every internal_sales workspace (TropiTech's own
 * hello@getcaye.com cold-outreach inbox), scans outreach_leads and:
 *   - drafts the ONE allowed follow-up (outreach-script.md §5) for leads
 *     2+ days past first_touch_sent_at with no reply and no prior nudge
 *   - marks a lead 'cold' (bookkeeping only, no message) once that one
 *     nudge is 14+ days old with still no reply — "then stop," not a
 *     second pitch
 * See lib/nudge-eligibility.ts's decideOutreachLeadAction for the exact
 * rule and lib/outreach-nudge.ts for the draft generator.
 *
 * Every draft lands as a held item (human_agent_enabled=true on a
 * unified_conversations row + a unified_messages hold row carrying
 * proposed_reply) — the same surface get_held_queue / stale-hold-sweep /
 * the Admin Shell already read. Nothing here ever sends: autosend_enabled
 * is hard-false for internal_sales workspaces (lib/autosend-gate.ts), and
 * this cron doesn't call sendZohoReply/sendZohoEmail at all, unlike
 * nudge-scan's ghosted-lead pass which sends directly for service_business
 * workspaces.
 *
 * Reply detection: a lead "has replied" if any unified_messages row with
 * sender_type='customer' exists on the unified_conversations row keyed by
 * (connected_account_id, channel_type='email', customer_id=lead_email) —
 * the same join pattern nudge-scan's ghosted-lead pass uses, per
 * outreach_leads' own migration comment (20260721c_outreach_leads.sql).
 * A lead with zero replies may have no conversation row yet at all (its
 * first-touch send went through sendZohoEmail, which doesn't create one) —
 * this route finds-or-creates one the first time it needs to write a hold.
 *
 * Authenticated via CRON_SECRET. Accepts either `x-cron-secret: <secret>`
 * or `Authorization: Bearer <secret>`. Register on cron-job.org (daily) —
 * see Products/Caye/CLAUDE.md; there is no vercel.json in this repo.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { recordCronRun } from '@/lib/cron-run-log'
import { enqueueHoldPing } from '@/lib/whatsapp/triggers'
import { generateOutreachFollowupDraft } from '@/lib/outreach-nudge'
import {
  decideOutreachLeadAction,
  type OutreachLeadCandidate,
} from '@/lib/nudge-eligibility'

const DEFAULT_SALES_SYSTEM_PROMPT =
  'You are drafting reply suggestions for the founder of a Bahamian tech ' +
  'company, reviewed and sent by him — never sent automatically.'

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    // Accept both shapes for consistency with the other newer-convention
    // crons — Bearer for standard clients, x-cron-secret for cron-job.org.
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    return NextResponse.json(await runOutreachNudgeScan())
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Core scan logic, extracted so both the scheduled cron hit above and a
 * future founder-triggered manual run (Admin Shell, matching the
 * trigger-cron.ts pattern used by other crons) call the exact same code.
 */
export async function runOutreachNudgeScan() {
  return recordCronRun('outreach-nudge-scan', async () => {
    const supabase = createServiceClient()
    const now = new Date()

    const summary = {
      workspaces_scanned: 0,
      leads_scanned: 0,
      drafted: 0,
      marked_cold: 0,
      errors: [] as string[],
    }

    const { data: workspaces } = await supabase
      .from('customers')
      .select('id')
      .eq('workspace_kind', 'internal_sales')

    for (const workspace of workspaces ?? []) {
      summary.workspaces_scanned++
      try {
        const counts = await processWorkspace(workspace.id, now)
        summary.leads_scanned += counts.leads_scanned
        summary.drafted += counts.drafted
        summary.marked_cold += counts.marked_cold
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        summary.errors.push(`workspace ${workspace.id}: ${msg}`)
        console.error(`[outreach-nudge-scan] workspace ${workspace.id} failed:`, err)
      }
    }

    return summary
  })
}

interface WorkspaceCounts {
  leads_scanned: number
  drafted: number
  marked_cold: number
}

async function processWorkspace(workspaceId: string, now: Date): Promise<WorkspaceCounts> {
  const supabase = createServiceClient()
  const counts: WorkspaceCounts = { leads_scanned: 0, drafted: 0, marked_cold: 0 }

  const [{ data: account }, { data: aiConfig }] = await Promise.all([
    supabase
      .from('connected_accounts')
      .select('id')
      .eq('user_id', workspaceId)
      .eq('channel_type', 'email')
      .eq('is_active', true)
      .maybeSingle(),
    supabase
      .from('workspace_ai_config')
      .select('system_prompt')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
  ])

  // Zoho not connected yet — nothing to draft or send from.
  if (!account) return counts

  const { data: leads } = await supabase
    .from('outreach_leads')
    .select(
      'id, lead_email, business_name, contact_name, first_touch_sent_at, nudge_count, last_nudge_at, opted_out_at, status'
    )
    .eq('workspace_id', workspaceId)
    .is('opted_out_at', null)
    .eq('status', 'sent')

  for (const lead of leads ?? []) {
    counts.leads_scanned++
    try {
      const outcome = await processLead(
        workspaceId,
        account.id,
        aiConfig?.system_prompt ?? DEFAULT_SALES_SYSTEM_PROMPT,
        lead,
        now
      )
      if (outcome === 'drafted') counts.drafted++
      if (outcome === 'marked_cold') counts.marked_cold++
    } catch (err) {
      console.error(`[outreach-nudge-scan] lead ${lead.lead_email} failed:`, err)
    }
  }

  return counts
}

interface OutreachLeadRow {
  id: string
  lead_email: string
  business_name: string | null
  contact_name: string | null
  first_touch_sent_at: string | null
  nudge_count: number
  last_nudge_at: string | null
  opted_out_at: string | null
  status: string
}

async function processLead(
  workspaceId: string,
  accountId: string,
  systemPrompt: string,
  lead: OutreachLeadRow,
  now: Date
): Promise<'drafted' | 'marked_cold' | 'none'> {
  const supabase = createServiceClient()

  // Find (not create) any existing conversation for this lead — a reply,
  // or a prior nudge's hold, would already have created one.
  const { data: conversation } = await supabase
    .from('unified_conversations')
    .select('id, metadata')
    .eq('connected_account_id', accountId)
    .eq('channel_type', 'email')
    .eq('customer_id', lead.lead_email)
    .maybeSingle()

  let hasReplied = false
  if (conversation) {
    const { count } = await supabase
      .from('unified_messages')
      .select('*', { count: 'exact', head: true })
      .eq('conversation_id', conversation.id)
      .eq('sender_type', 'customer')
    hasReplied = (count ?? 0) > 0
  }

  const candidate: OutreachLeadCandidate = {
    first_touch_sent_at: lead.first_touch_sent_at,
    nudge_count: lead.nudge_count,
    last_nudge_at: lead.last_nudge_at,
    opted_out_at: lead.opted_out_at,
    status: lead.status,
    has_replied: hasReplied,
  }

  const action = decideOutreachLeadAction(candidate, now)
  if (action === 'none') return 'none'

  if (action === 'mark_cold') {
    await supabase.from('outreach_leads').update({ status: 'cold' }).eq('id', lead.id)
    return 'marked_cold'
  }

  // action === 'nudge'
  const generated = await generateOutreachFollowupDraft({
    systemPrompt,
    leadName: lead.contact_name ?? lead.lead_email,
    businessName: lead.business_name ?? lead.lead_email,
  })

  if (!generated.ok) {
    console.warn(
      `[outreach-nudge-scan] draft failed (${generated.reason}) for ${lead.lead_email}`
    )
    return 'none'
  }

  let conversationId = conversation?.id
  let baseMetadata: Record<string, unknown> = (conversation?.metadata as Record<string, unknown>) ?? {}
  if (!conversationId) {
    baseMetadata = { source: 'outreach_leads', lead_id: lead.id }
    const { data: created, error: convErr } = await supabase
      .from('unified_conversations')
      .insert({
        connected_account_id: accountId,
        channel_type: 'email',
        channel_conversation_id: `outreach_${lead.id}`,
        customer_name: lead.contact_name ?? lead.business_name ?? lead.lead_email,
        customer_id: lead.lead_email,
        status: 'open',
        is_archived: false,
        metadata: baseMetadata,
      })
      .select('id')
      .single()

    if (convErr || !created) {
      console.error('[outreach-nudge-scan] conversation create failed:', convErr)
      return 'none'
    }
    conversationId = created.id
  }

  // Draft lives on the conversation's own metadata (not a duplicate
  // unified_messages "note" row — that used to carry it but became
  // content-free clutter once the dashboard stopped rendering
  // proposed_reply inline, see decisions-log). The dashboard reads
  // metadata.hold_kind==='outreach_followup' to auto-fill the compose box
  // ONLY for this narrow, policy-constrained follow-up case — general
  // holds/escalations still open empty, on purpose (a founder judgment
  // call shouldn't come pre-filled with tempting one-click-send filler).
  await supabase
    .from('unified_conversations')
    .update({
      human_agent_enabled: true,
      human_agent_reason: 'Cold-outreach follow-up drafted — no reply since first touch',
      metadata: { ...baseMetadata, hold_kind: 'outreach_followup', proposed_reply: generated.content },
    })
    .eq('id', conversationId)

  await supabase
    .from('outreach_leads')
    .update({ nudge_count: lead.nudge_count + 1, last_nudge_at: now.toISOString() })
    .eq('id', lead.id)

  // Awaited per the zoho-email webhook's own note (2026-07-04 Bridgette
  // Jones incident) — a fire-and-forget promise here can get torn down by
  // the serverless runtime before the ping actually sends.
  await enqueueHoldPing({
    workspaceId,
    conversationId,
    contactName: lead.contact_name ?? lead.business_name ?? lead.lead_email,
    reason: 'outreach_followup_drafted',
    proposedReply: generated.content,
    inboundBody: '(no inbound message — cold-outreach follow-up nudge)',
    urgency: 'routine',
  }).catch(err => console.error('[outreach-nudge-scan] enqueueHoldPing failed:', err))

  return 'drafted'
}
