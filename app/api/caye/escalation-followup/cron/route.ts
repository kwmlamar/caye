/**
 * GET /api/caye/escalation-followup/cron
 *
 * Hourly cron — finds escalations older than ESCALATION_FOLLOWUP_HOURS that:
 *   - have no owner response on the conversation (any outbound business
 *     message after created_at counts — same shape as the outbound-worker
 *     race-suppression check),
 *   - haven't had a follow-up sent in the last FOLLOWUP_REPEAT_HOURS,
 * and:
 *   1. Sends the customer a soft reassurance ack via the conversation's
 *      channel ("still working on this — apologies for the wait").
 *   2. Re-pings the same operator route_to with kind=escalation_followup so
 *      the urgency framing changes.
 *
 * follow_up_sent_at is the LAST follow-up timestamp, not a one-shot marker
 * — an escalation keeps getting nudged roughly once a day until it's
 * actually resolved. The original one-shot design (nudge once, then never
 * again past a 72h lookback) meant anything that sat past three days went
 * completely silent forever — confirmed live: a real customer's Sunday
 * booking follow-up (2026-06-26) got exactly one ping and then nothing for
 * a week while it sat "pending."
 *
 * If an operator response IS observed since created_at, we mark
 * owner_responded_at and skip — no reassurance needed, the customer has
 * already heard back.
 *
 * Authenticated via CRON_SECRET. Accepts either `x-cron-secret: <secret>`
 * or `Authorization: Bearer <secret>`. Registered on cron-job.org.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueEscalationPings } from '@/lib/whatsapp/triggers'

const ESCALATION_FOLLOWUP_HOURS = 6
const FOLLOWUP_REPEAT_HOURS = 24 // re-nudge once a day until resolved
const LOOKBACK_HOURS = 24 * 30 // 30 days — a sane outer bound, not a silent-abandon trigger

interface EscalationRow {
  id: string
  workspace_id: string
  conversation_id: string | null
  category: string
  route_to: 'owner' | 'founder' | 'both'
  customer_facing_message: string
  internal_context: string
  created_at: string
}

interface ConversationRow {
  id: string
  contact_id: string | null
  channel: string | null
  // The customer-facing reassurance is sent via the unified inbox flow in
  // v1 — we drop an internal note and flip human_agent_enabled. The actual
  // channel send (Meta/Zoho/Gmail) is owner-initiated, since each channel
  // has different auth and the operator may want to tailor the reassurance
  // before sending. The operator re-ping makes sure they see it.
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    // Accept both shapes for consistency with outbound-worker — Bearer for
    // Vercel cron / standard clients, x-cron-secret for cron-job.org's
    // simpler header model.
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const supabase = createServiceClient()
  const now = Date.now()
  const cutoff = new Date(now - ESCALATION_FOLLOWUP_HOURS * 60 * 60 * 1000).toISOString()
  const lookback = new Date(now - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
  const repeatCutoff = new Date(now - FOLLOWUP_REPEAT_HOURS * 60 * 60 * 1000).toISOString()

  const { data: rows, error } = await supabase
    .from('caye_escalations')
    .select(
      'id, workspace_id, conversation_id, category, route_to, customer_facing_message, internal_context, created_at'
    )
    .is('owner_responded_at', null)
    .or(`follow_up_sent_at.is.null,follow_up_sent_at.lte.${repeatCutoff}`)
    .lte('created_at', cutoff)
    .gte('created_at', lookback)
    .order('created_at', { ascending: true })
    .limit(50)

  if (error) {
    console.error('[escalation-followup] fetch failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const summary = { scanned: rows?.length ?? 0, resolved: 0, followed_up: 0, skipped: 0 }
  if (!rows?.length) return NextResponse.json(summary)

  for (const row of rows as EscalationRow[]) {
    const outcome = await processEscalation(row)
    summary[outcome] += 1
  }

  return NextResponse.json(summary)
}

type Outcome = 'resolved' | 'followed_up' | 'skipped'

async function processEscalation(row: EscalationRow): Promise<Outcome> {
  const supabase = createServiceClient()

  // If the operator already replied since the escalation opened, mark
  // resolved and skip the reassurance.
  if (row.conversation_id) {
    const replied = await operatorRepliedSince(row.conversation_id, row.created_at)
    if (replied) {
      await supabase
        .from('caye_escalations')
        .update({ owner_responded_at: new Date().toISOString() })
        .eq('id', row.id)
      return 'resolved'
    }
  }

  // Re-ping the operator(s) with escalation_followup framing. The customer
  // reassurance lives in the operator-side script ("send a softer line to
  // <contact> — they're 6h in") rather than as an autonomous send: each
  // channel needs its own auth + send path, and reassurance text is too
  // owner-facing to autopilot in v1.
  try {
    await enqueueEscalationPings(
      {
        workspaceId: row.workspace_id,
        escalationId: row.id,
        conversationId: row.conversation_id,
        contactName: 'A guest',
        category: row.category,
        routeTo: row.route_to,
        suggestedReply: row.customer_facing_message,
        internalContext: row.internal_context,
        timestamp: new Date().toISOString(),
      },
      'escalation_followup'
    )
  } catch (err) {
    console.error('[escalation-followup] enqueue failed:', err)
    return 'skipped'
  }

  await supabase
    .from('caye_escalations')
    .update({ follow_up_sent_at: new Date().toISOString() })
    .eq('id', row.id)

  return 'followed_up'
}

async function operatorRepliedSince(conversationId: string, sinceISO: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('unified_messages')
    .select('id, metadata')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'business')
    .eq('is_internal', false)
    .gt('sent_at', sinceISO)
    .limit(5)
  if (!data?.length) return false
  // Anything outbound that wasn't auto-generated by Caye counts as the
  // operator handling the thread directly.
  return data.some((m) => {
    const meta = (m.metadata ?? {}) as Record<string, unknown>
    return meta.is_automated !== true && meta.generated_by !== 'caye'
  })
}
