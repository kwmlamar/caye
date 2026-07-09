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
 * Founder-tier escalation (2026-07-03): confirmed pattern is decision-
 * avoidance, not just slow response — the operator sees these pings (quick-
 * reply buttons already exist) and still doesn't act. Nagging the same
 * person harder doesn't fix that, so escalations routed to 'owner' only
 * additionally loop in the founder once they've sat unresolved past a
 * threshold: FOUNDER_ESCALATION_URGENT_HOURS if the held item reads as
 * time-sensitive (near-term date / "today"/"tomorrow" language, reusing the
 * same classifyHoldUrgency heuristic as the hold-ping scheduler),
 * FOUNDER_ESCALATION_HOURS otherwise. This does NOT widen Caye's own
 * autonomy — every category that reaches this queue is a genuine judgment
 * call (b2b/complaint/refund/custom, pricing ambiguity, near-term changes);
 * the founder is a human backstop, not an auto-send path. Fires once per
 * escalation (founder_escalated_at is a one-shot marker, unlike
 * follow_up_sent_at which repeats).
 *
 * Authenticated via CRON_SECRET. Accepts either `x-cron-secret: <secret>`
 * or `Authorization: Bearer <secret>`. Registered on cron-job.org.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueEscalationPings } from '@/lib/whatsapp/triggers'
import { labelForCategory } from '@/lib/whatsapp/escalation'
import { classifyHoldUrgency } from '@/lib/whatsapp/urgency'
import type { EscalationCategory } from '@/lib/caye-reply'

const ESCALATION_FOLLOWUP_HOURS = 6
const FOLLOWUP_REPEAT_HOURS = 24 // re-nudge once a day until resolved
const LOOKBACK_HOURS = 24 * 30 // 30 days — a sane outer bound, not a silent-abandon trigger

const FOUNDER_ESCALATION_HOURS = 24 * 7 // 7 days — normal categories
const FOUNDER_ESCALATION_URGENT_HOURS = 24 // time-sensitive holds

interface EscalationRow {
  id: string
  workspace_id: string
  conversation_id: string | null
  category: string
  route_to: 'owner' | 'founder' | 'both'
  customer_facing_message: string
  internal_context: string
  ping_summary: string | null
  created_at: string
  founder_escalated_at: string | null
  target_date: string | null
}

/**
 * Plain-language "still waiting" summary for the follow-up ping. Reads
 * row.ping_summary, the clean summary persisted at escalation-creation time
 * (see lib/whatsapp/escalation.ts) — never internal_context, which is
 * dashboard-only debug text (raw classifier trigger names, keyword-match
 * reasons) that must not reach an owner's WhatsApp. Legacy rows created
 * before this column existed just get the category label.
 */
export function composeFollowupPingSummary(
  row: Pick<EscalationRow, 'ping_summary' | 'category'>
): string {
  const cleanSummary = row.ping_summary ?? labelForCategory(row.category as EscalationCategory)
  return `Still waiting — ${cleanSummary}`.slice(0, 200)
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
      'id, workspace_id, conversation_id, category, route_to, customer_facing_message, internal_context, ping_summary, created_at, founder_escalated_at, target_date'
    )
    .is('owner_responded_at', null)
    .is('expired_at', null)
    .or(`follow_up_sent_at.is.null,follow_up_sent_at.lte.${repeatCutoff}`)
    .lte('created_at', cutoff)
    .gte('created_at', lookback)
    .order('created_at', { ascending: true })
    .limit(50)

  if (error) {
    console.error('[escalation-followup] fetch failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const summary = {
    scanned: rows?.length ?? 0,
    resolved: 0,
    followed_up: 0,
    skipped: 0,
    founder_escalated: 0,
    expired: 0,
  }
  if (!rows?.length) return NextResponse.json(summary)

  for (const row of rows as EscalationRow[]) {
    const { outcome, founderEscalated } = await processEscalation(row)
    summary[outcome] += 1
    if (founderEscalated) summary.founder_escalated += 1
  }

  return NextResponse.json(summary)
}

type Outcome = 'resolved' | 'followed_up' | 'skipped' | 'expired'

async function processEscalation(
  row: EscalationRow
): Promise<{ outcome: Outcome; founderEscalated: boolean }> {
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
      return { outcome: 'resolved', founderEscalated: false }
    }
  }

  // Real customer name + a substantive summary — without this the ping
  // (and its mirror in Caye Direct) just says "A guest — <category>
  // escalation," which tells the operator nothing they can act on.
  let contactName = 'A guest'
  if (row.conversation_id) {
    const { data: conv } = await supabase
      .from('unified_conversations')
      .select('customer_name')
      .eq('id', row.conversation_id)
      .maybeSingle()
    if (conv?.customer_name) contactName = conv.customer_name
  }

  // The underlying window already passed (e.g. a specific booking date)
  // with no operator response. Nudging about a dead date is just noise —
  // send one final closing note instead of the usual "still waiting" ping,
  // mark expired so the cron stops selecting this row, and clear the hold
  // flag so it drops out of the inbox's needs-review view too. One-shot:
  // never goes fully silent (that's the exact bug the daily-repeat design
  // was originally built to avoid — see file header), it just stops asking
  // for a decision that's no longer possible to act on.
  const todayISO = new Date().toISOString().slice(0, 10)
  if (row.target_date && row.target_date < todayISO) {
    return expireEscalation(row, contactName)
  }

  const pingSummary = composeFollowupPingSummary(row)

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
        contactName,
        category: row.category,
        routeTo: row.route_to,
        suggestedReply: row.customer_facing_message,
        internalContext: row.internal_context,
        pingSummary,
        timestamp: new Date().toISOString(),
      },
      'escalation_followup'
    )
  } catch (err) {
    console.error('[escalation-followup] enqueue failed:', err)
    return { outcome: 'skipped', founderEscalated: false }
  }

  await supabase
    .from('caye_escalations')
    .update({ follow_up_sent_at: new Date().toISOString() })
    .eq('id', row.id)

  const founderEscalated = await maybeEscalateToFounder(row, contactName, pingSummary)

  return { outcome: 'followed_up', founderEscalated }
}

/**
 * One-shot closing ping + auto-resolve for an escalation whose target_date
 * has passed with no operator response. Sends a single "letting this go"
 * note via the existing ping pipeline (expired=true suppresses the "still
 * waiting"/"say the word" framing in both the WhatsApp template and the
 * Caye Direct log — see app/api/caye/outbound-worker/route.ts), sets
 * expired_at so the select query at the top of this file never picks the
 * row up again, and clears the conversation's hold flag so it also drops
 * out of the inbox's needs-review view. A failed send still marks expired —
 * the underlying date is dead either way, and nudging forever because a
 * WhatsApp send failed once would be worse than a silent skip.
 */
async function expireEscalation(
  row: EscalationRow,
  contactName: string
): Promise<{ outcome: Outcome; founderEscalated: boolean }> {
  const supabase = createServiceClient()
  const dateLabel = row.target_date
    ? new Date(`${row.target_date}T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : 'that window'
  const closingSummary =
    `Letting this go — ${contactName}'s ${dateLabel} date already passed with no word from you.`.slice(
      0,
      200
    )

  try {
    await enqueueEscalationPings(
      {
        workspaceId: row.workspace_id,
        escalationId: row.id,
        conversationId: row.conversation_id,
        contactName,
        category: row.category,
        routeTo: row.route_to,
        suggestedReply: row.customer_facing_message,
        internalContext: row.internal_context,
        pingSummary: closingSummary,
        timestamp: new Date().toISOString(),
        expired: true,
      },
      'escalation_followup'
    )
  } catch (err) {
    console.error('[escalation-followup] expiry ping failed:', err)
  }

  await supabase
    .from('caye_escalations')
    .update({ expired_at: new Date().toISOString() })
    .eq('id', row.id)

  if (row.conversation_id) {
    await supabase
      .from('unified_conversations')
      .update({ human_agent_enabled: false })
      .eq('id', row.conversation_id)
  }

  return { outcome: 'expired', founderEscalated: false }
}

/**
 * Loop the founder in once an 'owner'-only escalation has sat unresolved
 * past a threshold. Not an autonomous action on the customer side — this
 * only adds a recipient to the same escalation_followup ping, so a human
 * (you) becomes the backstop when the operator won't decide. Skips rows
 * already routed to 'founder' or 'both' (founder's already in the loop) and
 * fires at most once per escalation.
 */
async function maybeEscalateToFounder(
  row: EscalationRow,
  contactName: string,
  pingSummary: string
): Promise<boolean> {
  if (row.founder_escalated_at) return false
  if (row.route_to === 'founder' || row.route_to === 'both') return false

  const ageHours = (Date.now() - new Date(row.created_at).getTime()) / (60 * 60 * 1000)
  const urgent =
    classifyHoldUrgency({
      inboundBody: `${row.internal_context} ${row.customer_facing_message}`,
    }) === 'urgent'
  const threshold = urgent ? FOUNDER_ESCALATION_URGENT_HOURS : FOUNDER_ESCALATION_HOURS
  if (ageHours < threshold) return false

  const ageLabel = ageHours >= 24 ? `${Math.floor(ageHours / 24)}d` : `${Math.floor(ageHours)}h`

  try {
    await enqueueEscalationPings(
      {
        workspaceId: row.workspace_id,
        escalationId: row.id,
        conversationId: row.conversation_id,
        contactName,
        category: row.category,
        routeTo: 'founder',
        suggestedReply: row.customer_facing_message,
        internalContext: row.internal_context,
        pingSummary: `Operator hasn't acted in ${ageLabel} — ${pingSummary}`.slice(0, 200),
        timestamp: new Date().toISOString(),
      },
      'escalation_followup'
    )
  } catch (err) {
    console.error('[escalation-followup] founder escalation enqueue failed:', err)
    return false
  }

  const supabase = createServiceClient()
  await supabase
    .from('caye_escalations')
    .update({ founder_escalated_at: new Date().toISOString() })
    .eq('id', row.id)

  return true
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
