/**
 * GET /api/caye/outreach-autosend-scan
 *
 * Caye working her pipeline. One tick = one pass over every live lead,
 * asking the same question for each: given what I know about this person
 * right now, what is the most useful thing I can do next, and am I allowed
 * to do it myself?
 *
 *   observe state ─> decideNextAction ─> decideAuthority ─> act / stage / escalate
 *        ^                                                            │
 *        └──────────── record outcome + signals ──────────────────────┘
 *
 * The cron tick IS the loop's "keep going" step. That is deliberate: this
 * codebase's standing architecture decision is background jobs rather than
 * an agent framework, and a per-lead state machine re-entered on a schedule
 * gives genuine continuity without a runtime that can wander.
 *
 * What changed 2026-08-12 (decisions-log): this route used to answer "is a
 * nudge due?" and nothing else. Every judgment now lives in a pure,
 * unit-tested module under lib/sales/ — funnel stage, next action,
 * authority tier, truthfulness — and this file is the I/O shell that runs
 * them. Nothing here decides policy; it observes, calls the policy, and
 * carries out the verdict.
 *
 * Authenticated via CRON_SECRET (Bearer or x-cron-secret).
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { recordCronRun } from '@/lib/cron-run-log'
import { dispatchOperatorReply } from '@/lib/whatsapp/channel-dispatch'
import { enqueueHoldPing } from '@/lib/whatsapp/triggers'
import { generateOutreachFirstTouchDraft } from '@/lib/outreach-first-touch'
import { assignFirstTouchVariant } from '@/lib/sales/voice'
import { generateOutreachFollowupDraft } from '@/lib/outreach-nudge'
import { findOutreachDraftIssues, describeDraftIssues } from '@/lib/outreach-draft-guard'
import { findClaimIssues, describeClaimIssues } from '@/lib/sales/claims'
import { buildComplianceFooter } from '@/lib/outreach-compliance'
import { countOutreachSendsToday, OUTREACH_DAILY_FIRST_TOUCH_CAP } from '@/lib/outreach-send-limits'
import { type SalesAction } from '@/lib/sales/next-action'
import { decideSalesOutreachWorkflow } from '@/lib/sales/outreach-workflow'
import { decideAuthority, founderNoteFor, type SalesActionKind } from '@/lib/sales/authority'
import { recordSalesLifecycleEvent } from '@/lib/sales/lifecycle'
import type { SalesStage } from '@/lib/sales/funnel'
import { selectOutreachBatch } from '@/lib/outreach-batch'
import { isValidOutreachEmail } from '@/lib/outreach-email'
import { isProductionSalesWorkspace } from '@/lib/sales/workspace-eligibility'
import { getRevalidatableParkedDraft } from '@/lib/outreach-parked-draft'
import { reserveFirstTouchCapacity } from '@/lib/outreach-first-touch-capacity'

/** Leads examined per tick. Bounds runtime; the next tick picks up the rest. */
const LEAD_BATCH_SIZE = 40

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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

/** Index signature satisfies recordCronRun's Record<string, unknown> bound,
 *  which persists this straight into caye_cron_runs.last_summary. */
export interface ScanSummary {
  [key: string]: unknown
  workspaces_scanned: number
  leads_examined: number
  first_touch_sent: number
  followups_sent: number
  held_for_review: number
  escalated: number
  disqualified: number
  marked_cold: number
  no_action: number
  leads_considered: number
  errors: string[]
  rejection_reasons: Record<string, number>
  primary_zero_send_reason: string | null
}

export async function runOutreachAutosendScan(): Promise<ScanSummary> {
  return recordCronRun('outreach-autosend-scan', async () => {
    const supabase = createServiceClient()
    const now = new Date()
    const summary: ScanSummary = {
      workspaces_scanned: 0,
      leads_examined: 0,
      first_touch_sent: 0,
      followups_sent: 0,
      held_for_review: 0,
      escalated: 0,
      disqualified: 0,
      marked_cold: 0,
      no_action: 0,
      leads_considered: 0,
      errors: [],
      rejection_reasons: {},
      primary_zero_send_reason: null,
    }

    const { data: workspaces } = await supabase
      .from('customers')
      .select('id, workspace_kind, plan')
      .eq('workspace_kind', 'internal_sales')

  for (const workspace of workspaces ?? []) {
      if (!isProductionSalesWorkspace(workspace)) continue
      summary.workspaces_scanned++
      try {
        await processWorkspace(workspace.id, now, summary)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        summary.errors.push(`workspace ${workspace.id}: ${msg}`)
        console.error(`[outreach-autosend-scan] workspace ${workspace.id}:`, err)
      }
    }
    if (summary.first_touch_sent + summary.followups_sent === 0) {
      summary.primary_zero_send_reason = primaryZeroSendReason(summary)
    }
    return summary
  })
}

interface LeadRow {
  id: string
  lead_email: string
  business_name: string | null
  contact_name: string | null
  business_evidence: string | null
  demo_token: string | null
  stage: SalesStage
  first_touch_sent_at: string | null
  touches_sent: number
  last_touch_sent_at: string | null
  opted_out_at: string | null
  last_inbound_kind: 'human_reply' | 'automated_ooo' | 'opt_out' | 'bounce_or_delivery_failure' | 'unknown' | null
  outreach_deferred_at: string | null
  disqualified_reason: string | null
  created_at: string
}

interface ConversationRow {
  id: string
  customer_id: string
  metadata: unknown
  last_sender_type: string | null
  human_agent_enabled: boolean | null
}

async function processWorkspace(
  workspaceId: string,
  now: Date,
  summary: ScanSummary
): Promise<void> {
  const supabase = createServiceClient()

  const [{ data: account }, { data: aiConfig }, { data: customer }] = await Promise.all([
    supabase
      .from('connected_accounts')
      .select('id')
      .eq('user_id', workspaceId)
      .eq('channel_type', 'email')
      .eq('is_active', true)
      .maybeSingle(),
    supabase
      .from('workspace_ai_config')
      .select('outreach_autosend_paused')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    supabase.from('customers').select('ai_voice_profile').eq('id', workspaceId).maybeSingle(),
  ])

  if (!account) return // no mailbox connected; nothing to send from

  const outreachPaused = aiConfig?.outreach_autosend_paused ?? true
  const workspaceVoice = renderVoiceProfile(customer?.ai_voice_profile)

  // Budget observed once, then tracked locally across the run. Re-reading
  // per send would only ever reflect state from before the tick started.
  const sentToday = await countOutreachSendsToday(workspaceId)
  let remaining = Math.max(0, OUTREACH_DAILY_FIRST_TOUCH_CAP - sentToday.firstTouch)

  const { data: leads } = await supabase
    .from('outreach_leads')
    .select(
      'id, lead_email, business_name, contact_name, business_evidence, demo_token, stage, first_touch_sent_at, touches_sent, last_touch_sent_at, opted_out_at, last_inbound_kind, outreach_deferred_at, disqualified_reason, created_at'
    )
    .eq('workspace_id', workspaceId)
    .not('stage', 'in', '("won","lost","disqualified")')
    .is('outreach_claim_token', null)
    .order('created_at', { ascending: true })

  const leadRows = (leads ?? []) as LeadRow[]
  const { data: conversations } = leadRows.length
    ? await supabase.from('unified_conversations')
      .select('id, customer_id, metadata, last_sender_type, human_agent_enabled')
      .eq('connected_account_id', account.id).eq('channel_type', 'email')
      .in('customer_id', leadRows.map((lead) => lead.lead_email))
    : { data: [] }
  const conversationsByEmail = new Map((conversations ?? []).map((row) => [String(row.customer_id).toLowerCase(), row]))
  const actionable = leadRows.filter((lead) => {
    summary.leads_considered++
    if (!isValidOutreachEmail(lead.lead_email)) {
      countReason(summary, 'invalid_email')
      return false
    }
    const conversation = conversationsByEmail.get(lead.lead_email.toLowerCase())
    const action = decideSalesOutreachWorkflow({
      stage: lead.stage, firstTouchSentAt: lead.first_touch_sent_at, touchesSent: lead.touches_sent,
      lastTouchSentAt: lead.last_touch_sent_at, optedOutAt: lead.opted_out_at,
      inboundKind: lead.last_inbound_kind, outreachDeferredAt: lead.outreach_deferred_at,
      disqualifyingSignal: lead.disqualified_reason, conversationLastSenderType: conversation?.last_sender_type,
    }, now)
    if (action.kind === 'do_nothing') {
      countReason(summary, action.reason)
      return false
    }
    return true
  })

  for (const lead of selectOutreachBatch(actionable, LEAD_BATCH_SIZE)) {
    const claimToken = randomUUID()
    const { data: claimed } = await supabase.from('outreach_leads')
      .update({ outreach_claim_token: claimToken, outreach_claimed_at: now.toISOString() })
      .eq('id', lead.id).is('outreach_claim_token', null).select('id').maybeSingle()
    if (!claimed) continue
    summary.leads_examined++
    try {
      const consumed = await processLead({
        lead,
        workspaceId,
        accountId: account.id,
        workspaceVoice,
        outreachPaused,
        remaining,
        now,
        summary,
        prefetchedConversation: conversationsByEmail.get(lead.lead_email.toLowerCase()),
      })
      remaining -= consumed
      await supabase.from('outreach_leads').update({ outreach_claim_token: null, outreach_claimed_at: null })
        .eq('id', lead.id).eq('outreach_claim_token', claimToken)
    } catch (err) {
      console.error(`[outreach-autosend-scan] lead ${lead.lead_email}:`, err)
      summary.errors.push(`lead ${lead.lead_email}: ${err instanceof Error ? err.message : String(err)}`)
      countReason(summary, 'ambiguous_failure_claim_retained')
    }
  }
}

/** @returns how much send budget this lead consumed (0 or 1). */
export async function processLead(args: {
  lead: LeadRow
  workspaceId: string
  accountId: string
  workspaceVoice: string
  outreachPaused: boolean
  remaining: number
  now: Date
  summary: ScanSummary
  prefetchedConversation?: ConversationRow
}): Promise<number> {
  const { lead, workspaceId, accountId, workspaceVoice, outreachPaused, remaining, now, summary } = args
  const supabase = createServiceClient()

  // ── OBSERVE ────────────────────────────────────────────────────────────
  // Reply state is computed from the inbox rather than trusted from a
  // column, per the original outreach_leads design note: one join, not a
  // second source of truth that can drift from what actually happened.
  const conversation = args.prefetchedConversation

  const hasUnansweredReply = lead.last_inbound_kind === 'human_reply' && conversation?.last_sender_type === 'customer'

  // A queued outreach draft is not a generic owner hold. Re-use it only
  // after the entire current deterministic send policy has been evaluated;
  // do not generate alternate copy or bulk-release old queue items.
  const meta = (conversation?.metadata ?? {}) as Record<string, unknown>

  const action = decideSalesOutreachWorkflow({
    stage: lead.stage,
    firstTouchSentAt: lead.first_touch_sent_at,
    touchesSent: lead.touches_sent,
    lastTouchSentAt: lead.last_touch_sent_at,
    optedOutAt: lead.opted_out_at,
    inboundKind: lead.last_inbound_kind,
    outreachDeferredAt: lead.outreach_deferred_at,
    disqualifyingSignal: lead.disqualified_reason,
    conversationLastSenderType: conversation?.last_sender_type,
  }, now)
  if (action.kind === 'do_nothing') {
    summary.no_action++
    countReason(summary, action.reason)
    return 0
  }

  // Bookkeeping actions need no draft and no send budget.
  if (action.kind === 'mark_disqualified') {
    await recordSalesLifecycleEvent({ workspaceId, leadId: lead.id, event: 'disqualified', eventKey: `disqualified:${lead.id}`, reason: action.reason })
    summary.disqualified++
    return 0
  }
  if (action.kind === 'mark_cold') {
    await recordSalesLifecycleEvent({ workspaceId, leadId: lead.id, event: 'marked_cold', eventKey: `cold:${lead.id}` })
    summary.marked_cold++
    return 0
  }

  // Answering an inbound reply is the front-desk engine's job, not this
  // cron's — it has the thread context and the conversational tools. The
  // reply path picks this up on its own; the scan only notes that the lead
  // has moved and stays out of the way.
  if (action.kind === 'reply_to_prospect') {
    // Inbound ingestion has already recorded the normalized human-reply event.
    summary.no_action++
    return 0
  }

  if (!lead.demo_token) {
    countReason(summary, 'missing_demo_token')
    return 0
  }

  // ── DRAFT ──────────────────────────────────────────────────────────────
  const leadName = lead.contact_name || lead.lead_email
  const businessName = lead.business_name || lead.lead_email
  // Deterministic from the lead id, so a retried/resent draft always lands
  // in the same variant bucket instead of flapping between framings.
  const variant = assignFirstTouchVariant(lead.id)
  let subject: string
  let body: string
  const parkedDraft = (action.kind === 'send_first_touch' || action.kind === 'send_followup')
    ? getRevalidatableParkedDraft({
        humanAgentEnabled: conversation?.human_agent_enabled,
        metadata: conversation?.metadata,
        hasUnansweredReply,
        action: action.kind,
      })
    : null

  if (parkedDraft) {
    // A legacy queue item gets the same content/claim guards and authority
    // verdict as a fresh draft below. It is never released just because a
    // deployment changed; a failed revalidation remains held.
    subject = parkedDraft.subject ?? (action.kind === 'send_first_touch' ? 'Quick question' : deriveFollowupSubject(conversation?.metadata))
    body = parkedDraft.body
  } else if (action.kind === 'send_first_touch') {
    const drafted = await generateOutreachFirstTouchDraft({
      workspaceVoice, leadName, businessName, demoToken: lead.demo_token,
      variant, evidence: lead.business_evidence,
    })
    if (!drafted.ok) {
      countReason(summary, `draft_failed:${drafted.reason}`)
      console.warn(`[outreach-autosend-scan] first-touch draft failed (${drafted.reason}) for ${lead.lead_email}`)
      return 0
    }
    subject = drafted.subject
    body = drafted.body
  } else {
    const drafted = await generateOutreachFollowupDraft({
      workspaceVoice, leadName, businessName,
      demoToken: lead.demo_token,
      touchNumber: (action as Extract<SalesAction, { kind: 'send_followup' }>).touchNumber,
    })
    if (!drafted.ok) {
      countReason(summary, `draft_failed:${drafted.reason}`)
      console.warn(`[outreach-autosend-scan] follow-up draft failed (${drafted.reason}) for ${lead.lead_email}`)
      return 0
    }
    subject = deriveFollowupSubject(conversation?.metadata)
    body = drafted.content
  }

  // ── AUTHORITY ──────────────────────────────────────────────────────────
  // Both guards run before the tier is decided, so a draft that is untrue
  // or off-voice can never be classified as routine.
  const styleIssues = findOutreachDraftIssues(body)
  const claimIssues = findClaimIssues(body)
  const guardFailure =
    styleIssues.length > 0 || claimIssues.length > 0
      ? [
          styleIssues.length ? describeDraftIssues(styleIssues) : '',
          claimIssues.length ? describeClaimIssues(claimIssues) : '',
        ].filter(Boolean).join('; ')
      : null

  const actionKind: SalesActionKind =
    action.kind === 'send_first_touch' ? 'send_first_touch' : 'send_followup'

  const verdict = decideAuthority({
    action: actionKind,
    draftFailedGuards: Boolean(guardFailure),
    outreachPaused,
    atDailyCap: action.kind === 'send_first_touch' && remaining <= 0,
  })

  const conversationId = conversation?.id ?? (await createLeadConversation({
    accountId, lead, subject, leadName, businessName,
  }))
  if (!conversationId) return 0

  const baseMetadata = (conversation?.metadata as Record<string, unknown>) ?? {
    source: 'outreach_leads',
    lead_id: lead.id,
  }
  const holdKind = action.kind === 'send_first_touch' ? 'outreach_first_touch' : 'outreach_followup'
  // Audit only structured decision data, never the generated body. Each send
  // is an atomic one-recipient action; `remaining_first_touch_capacity`
  // captures the campaign envelope that limits repeated safe actions.
  const autonomy = {
    decision: verdict.decision,
    reasons: verdict.reasons,
    action: action.kind,
    atomic_recipients: 1,
    evidence_sufficient: !guardFailure,
    campaign: {
      first_touch_cap: OUTREACH_DAILY_FIRST_TOUCH_CAP,
      remaining_first_touch_capacity: Math.max(0, remaining),
      outreach_paused: outreachPaused,
    },
  }
  const metadata = { ...baseMetadata, hold_kind: holdKind, subject, proposed_reply: body, autonomy }

  // ── ACT ────────────────────────────────────────────────────────────────
  if (verdict.tier !== 'auto') {
    if (parkedDraft) {
      // This was already staged. Do not create a fresh owner ping on every
      // cron tick; persist the current structured blocker so it is clear this
      // is a real policy stop, not a legacy approval artefact.
      await supabase
        .from('unified_conversations')
        .update({ metadata: { ...metadata, outreach_park: { decision: verdict.decision, reason: verdict.reasons[0] ?? 'policy_stop', action: action.kind } } })
        .eq('id', conversationId)
      summary.no_action++
      countReason(summary, verdict.reasons[0] ?? 'parked_draft_not_authorized')
      return 0
    }
    const note = founderNoteFor(
      verdict,
      guardFailure
        ? `Draft for ${businessName} did not pass: ${guardFailure}.`
        : `Draft ready for ${businessName}.`
    )
    await supabase
      .from('unified_conversations')
    .update({ human_agent_enabled: true, human_agent_reason: note, metadata: { ...metadata, outreach_park: { decision: verdict.decision, reason: verdict.reasons[0] ?? 'approval_required', action: action.kind } } })
      .eq('id', conversationId)
    await recordSalesLifecycleEvent({ workspaceId, leadId: lead.id, event: 'escalated', eventKey: `held:${conversationId}:${holdKind}`, reason: guardFailure ?? verdict.reasons[0] ?? null })
    await enqueueHoldPing({
      workspaceId, conversationId, contactName: businessName,
      reason: 'outreach_draft_held', proposedReply: body,
      inboundBody: '(no inbound message, outbound draft held for review)',
      urgency: 'routine',
    }).catch((err) => console.error('[outreach-autosend-scan] hold ping failed:', err))
    summary.held_for_review++
    countReason(summary, verdict.reasons[0] ?? 'held_unknown')
    return 0
  }

  // A local `remaining` value keeps this scan efficient, but only this
  // database reservation is authoritative across overlapping workers.
  if (action.kind === 'send_first_touch') {
    const reserved = await reserveFirstTouchCapacity(workspaceId, lead.id, now)
    if (!reserved) {
      await supabase.from('unified_conversations').update({
        metadata: { ...metadata, outreach_park: { decision: 'require_approval', reason: 'daily_cap_reached', action: action.kind } },
      }).eq('id', conversationId)
      summary.no_action++
      countReason(summary, 'daily_cap_reached')
      return 0
    }
  }

  await supabase.from('unified_conversations').update({ metadata: { ...metadata, outreach_park: null } }).eq('id', conversationId)
  const idempotencyKey = action.kind === 'send_first_touch'
    ? `outreach:first_touch:${lead.id}`
    : `outreach:followup:${lead.id}:touch:${action.touchNumber}`
  const dispatch = await dispatchOperatorReply(
    conversationId,
    body + buildComplianceFooter(lead.demo_token),
    'caye-outreach-autonomous',
    idempotencyKey
  )

  // The channel dispatch only returns after provider success and persisted
  // execution evidence. Its idempotency key makes a retry return the same
  // receipt instead of issuing another external send.
  if (!dispatch.success) return 0

  // If a prior attempt persisted the outbound message but died before its
  // lifecycle write, dispatch returns the same receipt without re-sending.
  // Complete that missing transition here; the lifecycle receipt makes this
  // harmless when the original attempt did finish it.
  if (dispatch.deduped && dispatch.messageId) {
    await recordSalesLifecycleEvent({
      workspaceId,
      leadId: lead.id,
      event: action.kind === 'send_first_touch' ? 'first_touch_sent' : 'followup_sent',
      eventKey: `outbound:${dispatch.messageId}`,
    })
  }

  // dispatchOperatorReply records the successful persisted outbound message
  // through the lifecycle seam, including manual and automatic sends.
  if (action.kind === 'send_first_touch') {
    // Best-effort attribution write, separate from the lifecycle seam above
    // (which owns stage/status): a failure here must never undo an already
    // -dispatched send, so it is logged rather than thrown or retried.
    const { error: variantError } = await supabase
      .from('outreach_leads')
      .update({ first_touch_variant: variant })
      .eq('id', lead.id)
    if (variantError) {
      console.error(`[outreach-autosend-scan] variant write failed for ${lead.lead_email}:`, variantError.message)
    }
    summary.first_touch_sent++
    return 1
  }
  summary.followups_sent++
  // Follow-ups are tracked separately and cannot consume or satisfy the
  // first-touch acquisition target.
  return 0
}

function countReason(summary: ScanSummary, reason: string): void {
  summary.rejection_reasons[reason] = (summary.rejection_reasons[reason] ?? 0) + 1
}

function primaryZeroSendReason(summary: ScanSummary): string {
  if (summary.errors.length) return 'scan_errors'
  if (summary.leads_examined === 0) return 'no_active_leads'
  if (summary.held_for_review > 0) return 'all_sendable_work_held'
  return Object.entries(summary.rejection_reasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'telemetry_incomplete'
}

async function createLeadConversation(args: {
  accountId: string
  lead: LeadRow
  subject: string
  leadName: string
  businessName: string
}): Promise<string | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('unified_conversations')
    .insert({
      connected_account_id: args.accountId,
      channel_type: 'email',
      channel_conversation_id: `outreach_${args.lead.id}`,
      customer_name: args.lead.contact_name || args.lead.business_name || args.lead.lead_email,
      customer_id: args.lead.lead_email,
      status: 'open',
      is_archived: false,
      metadata: { source: 'outreach_leads', lead_id: args.lead.id, subject: args.subject },
    })
    .select('id')
    .single()
  if (error || !data) {
    console.error('[outreach-autosend-scan] conversation create failed:', error)
    return null
  }
  return data.id
}

/** Follow-ups thread onto the original subject so they land in the same thread. */
function deriveFollowupSubject(metadata: unknown): string {
  const meta = (metadata ?? {}) as Record<string, unknown>
  return typeof meta.subject === 'string' && meta.subject.trim() ? meta.subject : 'Following up'
}

/**
 * Flattens the stored voice profile into prose for the prompt. Kept narrow
 * on purpose: only fields that describe HOW to write. Policy never comes
 * from here, so an edit in the dashboard cannot widen Caye's authority.
 */
function renderVoiceProfile(profile: unknown): string {
  const p = (profile ?? {}) as Record<string, unknown>
  const parts: string[] = []
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string).trim() : '')
  if (str('writing_style')) parts.push(`Writing style: ${str('writing_style')}`)
  if (str('tone_notes')) parts.push(`Tone: ${str('tone_notes')}`)
  if (Array.isArray(p.common_phrases) && p.common_phrases.length) {
    parts.push(`Phrases that sound like him: ${(p.common_phrases as string[]).slice(0, 10).join('; ')}`)
  }
  return parts.length ? `HOW LAMAR SOUNDS\n${parts.join('\n')}` : ''
}
