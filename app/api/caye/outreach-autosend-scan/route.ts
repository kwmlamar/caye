/**
 * GET /api/caye/outreach-autosend-scan
 *
 * Replaces app/api/caye/outreach-nudge-scan (deleted 2026-08-12) — fully
 * autonomous cold outreach (decisions-log 2026-08-12, reversing the
 * 2026-07-21 "step 4 permanently off" decision). Hourly cron, two jobs per
 * internal_sales workspace:
 *   1. FIRST TOUCH — drafts + sends outreach_leads rows with
 *      status='sourced' (created by outreach-sourcing-scan).
 *   2. FOLLOW-UP — up to 2 more touches (3 total) per
 *      lib/nudge-eligibility.ts's decideOutreachLeadAction, sent directly
 *      instead of held (was hold-only through 2026-08-12).
 *
 * Both send paths route through lib/whatsapp/channel-dispatch.ts's
 * dispatchOperatorReply rather than calling sendZohoEmail/sendZohoReply
 * directly — that function already owns Zoho threading (the 2026-08-01
 * unthreaded-follow-up incident), unified_messages recording, and the
 * outreach_leads status/first_touch_sent_at bookkeeping on the first-touch
 * branch. Reinventing a parallel send path here would risk the exact
 * threading bug that function's own doc comment warns about. The CAN-SPAM
 * footer (lib/outreach-compliance.ts) is appended to the body text before
 * calling it, since dispatchOperatorReply itself is generic across every
 * workspace's Caye deployment and shouldn't know about outreach compliance.
 *
 * SAFETY GATES, checked once per workspace per run:
 *   - workspace_ai_config.outreach_autosend_paused — if true (default),
 *     drafts still get generated and content-guard-checked, but land as a
 *     held item for manual review/send instead of sending. Tripped
 *     automatically by lib/outreach-kill-switch.ts on a bounce spike, or
 *     manually via the founder dashboard settings.
 *   - lib/outreach-send-limits.ts's OUTREACH_DAILY_SEND_CAP (50/day) — a
 *     live remaining-budget counter tracked locally across this run (not
 *     re-queried per send), since a single run could otherwise blow past
 *     the cap processing one batch.
 *   - lib/outreach-draft-guard.ts's findOutreachDraftIssues — a draft that
 *     fails content checks (banned hedge phrases, unfilled placeholders)
 *     always falls back to held-for-review, regardless of the gates above.
 *     Fails closed, never sends a suspect draft on the assumption it's
 *     probably fine (mirrors send-outreach-batch.ts's same check).
 *
 * Authenticated via CRON_SECRET. Accepts either `x-cron-secret: <secret>`
 * or `Authorization: Bearer <secret>`. Registered on cron-job.org via
 * scripts/register-outreach-crons.ts.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { recordCronRun } from '@/lib/cron-run-log'
import { dispatchOperatorReply } from '@/lib/whatsapp/channel-dispatch'
import { enqueueHoldPing } from '@/lib/whatsapp/triggers'
import { generateOutreachFirstTouchDraft } from '@/lib/outreach-first-touch'
import { generateOutreachFollowupDraft } from '@/lib/outreach-nudge'
import { findOutreachDraftIssues, describeDraftIssues } from '@/lib/outreach-draft-guard'
import { buildComplianceFooter } from '@/lib/outreach-compliance'
import { countSentToday, OUTREACH_DAILY_SEND_CAP } from '@/lib/outreach-send-limits'
import { decideOutreachLeadAction, type OutreachLeadCandidate } from '@/lib/nudge-eligibility'

const DEFAULT_SALES_SYSTEM_PROMPT =
  'You are TropiTech\'s founder reaching out to prospective Caye customers.'

const FIRST_TOUCH_BATCH_SIZE = 20

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
    return NextResponse.json(await runOutreachAutosendScan())
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function runOutreachAutosendScan() {
  return recordCronRun('outreach-autosend-scan', async () => {
    const supabase = createServiceClient()
    const now = new Date()

    const summary = {
      workspaces_scanned: 0,
      first_touch_sent: 0,
      first_touch_held: 0,
      followups_sent: 0,
      followups_held: 0,
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
        const r = await processWorkspace(workspace.id, now)
        summary.first_touch_sent += r.first_touch_sent
        summary.first_touch_held += r.first_touch_held
        summary.followups_sent += r.followups_sent
        summary.followups_held += r.followups_held
        summary.marked_cold += r.marked_cold
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        summary.errors.push(`workspace ${workspace.id}: ${msg}`)
        console.error(`[outreach-autosend-scan] workspace ${workspace.id} failed:`, err)
      }
    }

    return summary
  })
}

interface WorkspaceCounts {
  first_touch_sent: number
  first_touch_held: number
  followups_sent: number
  followups_held: number
  marked_cold: number
}

async function processWorkspace(workspaceId: string, now: Date): Promise<WorkspaceCounts> {
  const supabase = createServiceClient()
  const counts: WorkspaceCounts = {
    first_touch_sent: 0, first_touch_held: 0, followups_sent: 0, followups_held: 0, marked_cold: 0,
  }

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
      .select('system_prompt, outreach_autosend_paused')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
  ])

  // Zoho not connected yet — nothing to draft or send from.
  if (!account) return counts

  const paused = aiConfig?.outreach_autosend_paused ?? true
  const systemPrompt = aiConfig?.system_prompt ?? DEFAULT_SALES_SYSTEM_PROMPT

  // Live remaining-budget counter for this run — see route doc comment.
  let remaining = paused ? 0 : OUTREACH_DAILY_SEND_CAP - (await countSentToday(workspaceId))

  // ── First touch ──────────────────────────────────────────────────────
  const { data: sourcedLeads } = await supabase
    .from('outreach_leads')
    .select('id, lead_email, business_name, contact_name, demo_token')
    .eq('workspace_id', workspaceId)
    .eq('status', 'sourced')
    .is('opted_out_at', null)
    .limit(FIRST_TOUCH_BATCH_SIZE)

  for (const lead of sourcedLeads ?? []) {
    try {
      const canSend = remaining > 0
      const outcome = await processFirstTouch(account.id, systemPrompt, lead, canSend)
      if (outcome === 'sent') { counts.first_touch_sent++; remaining-- }
      if (outcome === 'held') counts.first_touch_held++
    } catch (err) {
      console.error(`[outreach-autosend-scan] first-touch ${lead.lead_email} failed:`, err)
    }
  }

  // ── Follow-ups ───────────────────────────────────────────────────────
  const { data: sentLeads } = await supabase
    .from('outreach_leads')
    .select('id, lead_email, business_name, contact_name, demo_token, first_touch_sent_at, nudge_count, last_nudge_at, opted_out_at, status')
    .eq('workspace_id', workspaceId)
    .is('opted_out_at', null)
    .eq('status', 'sent')

  for (const lead of sentLeads ?? []) {
    try {
      const canSend = remaining > 0
      const outcome = await processFollowup(workspaceId, account.id, systemPrompt, lead, now, canSend)
      if (outcome === 'sent') { counts.followups_sent++; remaining-- }
      if (outcome === 'held') counts.followups_held++
      if (outcome === 'marked_cold') counts.marked_cold++
    } catch (err) {
      console.error(`[outreach-autosend-scan] follow-up ${lead.lead_email} failed:`, err)
    }
  }

  return counts
}

interface SourcedLeadRow {
  id: string
  lead_email: string
  business_name: string | null
  contact_name: string | null
  demo_token: string | null
}

async function processFirstTouch(
  accountId: string,
  systemPrompt: string,
  lead: SourcedLeadRow,
  canSend: boolean
): Promise<'sent' | 'held' | 'skipped'> {
  const supabase = createServiceClient()
  if (!lead.demo_token) return 'skipped'

  const generated = await generateOutreachFirstTouchDraft({
    systemPrompt,
    leadName: lead.contact_name ?? lead.lead_email,
    businessName: lead.business_name ?? lead.lead_email,
    demoToken: lead.demo_token,
  })
  if (!generated.ok) {
    console.warn(`[outreach-autosend-scan] first-touch draft failed (${generated.reason}) for ${lead.lead_email}`)
    return 'skipped'
  }

  const issues = findOutreachDraftIssues(generated.body)
  const metadata = {
    source: 'outreach_leads',
    lead_id: lead.id,
    hold_kind: 'outreach_first_touch',
    subject: generated.subject,
    proposed_reply: generated.body,
  }

  const { data: created, error: convErr } = await supabase
    .from('unified_conversations')
    .insert({
      connected_account_id: accountId,
      channel_type: 'email',
      channel_conversation_id: `outreach_${lead.id}`,
      customer_name: lead.contact_name || lead.business_name || lead.lead_email,
      customer_id: lead.lead_email,
      status: 'open',
      is_archived: false,
      human_agent_enabled: true,
      human_agent_reason: issues.length > 0
        ? `First-touch draft failed content guard: ${describeDraftIssues(issues)}`
        : (canSend ? 'Autonomous first-touch — sending' : 'Autonomous first-touch drafted — outreach autosend is paused or at today\'s cap, review and send from the dashboard'),
      metadata,
    })
    .select('id')
    .single()

  if (convErr || !created) {
    console.error('[outreach-autosend-scan] first-touch conversation create failed:', convErr)
    return 'skipped'
  }

  if (issues.length > 0 || !canSend) {
    await supabase.from('outreach_leads').update({ status: 'draft' }).eq('id', lead.id)
    return 'held'
  }

  const bodyWithFooter = generated.body + buildComplianceFooter(lead.demo_token)
  // dispatchOperatorReply flips outreach_leads.status='sent' +
  // first_touch_sent_at itself (channel-dispatch.ts's own bookkeeping) —
  // nothing more to update here.
  await dispatchOperatorReply(created.id, bodyWithFooter, 'caye-dashboard')
  return 'sent'
}

interface SentLeadRow {
  id: string
  lead_email: string
  business_name: string | null
  contact_name: string | null
  demo_token: string | null
  first_touch_sent_at: string | null
  nudge_count: number
  last_nudge_at: string | null
  opted_out_at: string | null
  status: string
}

async function processFollowup(
  workspaceId: string,
  accountId: string,
  systemPrompt: string,
  lead: SentLeadRow,
  now: Date,
  canSend: boolean
): Promise<'sent' | 'held' | 'marked_cold' | 'none'> {
  const supabase = createServiceClient()

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

  if (!lead.demo_token) return 'none'

  // action === 'nudge'. nudge_count 0 → this is the 2nd touch overall
  // (1st follow-up); nudge_count 1 → 3rd/final touch.
  const touchNumber: 2 | 3 = lead.nudge_count === 0 ? 2 : 3

  const generated = await generateOutreachFollowupDraft({
    systemPrompt,
    leadName: lead.contact_name ?? lead.lead_email,
    businessName: lead.business_name ?? lead.lead_email,
    demoToken: lead.demo_token,
    touchNumber,
  })
  if (!generated.ok) {
    console.warn(`[outreach-autosend-scan] follow-up draft failed (${generated.reason}) for ${lead.lead_email}`)
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
      console.error('[outreach-autosend-scan] follow-up conversation create failed:', convErr)
      return 'none'
    }
    conversationId = created.id
  }

  const issues = findOutreachDraftIssues(generated.content)
  // baseMetadata carries `subject` forward if this conversation was
  // created by processFirstTouch above — dispatchOperatorReply's reply
  // branch reads meta.subject for the "Re: " line.
  const proposedMetadata = { ...baseMetadata, hold_kind: 'outreach_followup', proposed_reply: generated.content }

  // Bump counters at draft-attempt time regardless of send/hold outcome —
  // each touch is attempted at most once. If bumped only on actual send,
  // a later manual send of a held draft via send_outreach_batch (which
  // doesn't bump nudge_count itself) would leave the cadence under-counted
  // and risk a duplicate touch generating on top of it.
  await supabase
    .from('outreach_leads')
    .update({ nudge_count: lead.nudge_count + 1, last_nudge_at: now.toISOString() })
    .eq('id', lead.id)

  if (issues.length > 0 || !canSend) {
    await supabase
      .from('unified_conversations')
      .update({
        human_agent_enabled: true,
        human_agent_reason: issues.length > 0
          ? `Follow-up draft failed content guard: ${describeDraftIssues(issues)}`
          : 'Autonomous follow-up drafted — outreach autosend is paused or at today\'s cap, review and send from the dashboard',
        metadata: proposedMetadata,
      })
      .eq('id', conversationId)

    await enqueueHoldPing({
      workspaceId,
      conversationId,
      contactName: lead.contact_name ?? lead.business_name ?? lead.lead_email,
      reason: 'outreach_followup_drafted',
      proposedReply: generated.content,
      inboundBody: '(no inbound message — cold-outreach follow-up nudge)',
      urgency: 'routine',
    }).catch(err => console.error('[outreach-autosend-scan] enqueueHoldPing failed:', err))

    return 'held'
  }

  await supabase.from('unified_conversations').update({ metadata: proposedMetadata }).eq('id', conversationId)
  const bodyWithFooter = generated.content + buildComplianceFooter(lead.demo_token)
  await dispatchOperatorReply(conversationId, bodyWithFooter, 'caye-dashboard')
  return 'sent'
}
