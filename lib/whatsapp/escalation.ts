import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueEscalationPings } from './triggers'
import { extractTargetDate } from './urgency'
import type {
  CayeAutoReply,
  EscalationCategory,
  EscalationRouteTo,
} from '@/lib/caye-reply'

export interface RecordEscalationInput {
  workspaceId: string
  conversationId: string | null
  contactName: string
  category: EscalationCategory
  routeTo: EscalationRouteTo
  customerFacingMessage: string
  internalContext: string
  /** Optional one-line operator-friendly summary for the WhatsApp ping.
   *  Forced escalations always supply one; LLM-driven escalate_to_team
   *  falls back to deriving from category + customerFacingMessage. */
  pingSummary?: string
}

/**
 * Persist an escalation event + fan out operator pings. Called by every
 * channel webhook that observes `action: 'escalate'` from caye-reply.
 *
 * - Writes a caye_escalations row (used by the 6h follow-up cron).
 * - Marks the conversation `human_agent_enabled` so it surfaces in the inbox.
 * - Enqueues one outbound row per recipient phone via enqueueEscalationPings.
 *
 * Best-effort everywhere — a failure here must not block the customer-facing
 * reply that already went out on the wire.
 */
export async function recordEscalation(
  input: RecordEscalationInput
): Promise<{ escalationId: string | null }> {
  const supabase = createServiceClient()

  // Derive a fallback ping summary for LLM-driven escalations that didn't
  // supply one. internalContext is already written as operator-ready prose
  // by the escalate_to_team tool contract (a 2-5 sentence handoff note
  // ending in a concrete yes/no proposal — see lib/caye-reply.ts) so it can
  // be used as-is; no category-label prefix ("Policy call —", "Knowledge
  // gap —") gets prepended, since that's internal taxonomy jargon, not
  // something an operator needs to read at a glance. Caps at 200 chars.
  //
  // Persisted (not just used for the immediate ping) so the escalation-
  // followup cron can re-ping days later with the same clean text instead
  // of reconstructing one from internal_context on every read.
  const pingSummary =
    input.pingSummary ?? input.internalContext.replace(/\s+/g, ' ').trim().slice(0, 200)

  // Best-effort target date, so the follow-up cron can stop nudging once
  // the underlying window has passed (confirmed live: a "July 4th booking"
  // escalation kept getting a daily "still waiting" ping days after July
  // 4th was gone). Null when no concrete date is mentioned — the cron just
  // keeps its existing behavior for those rows.
  const targetDate = extractTargetDate(`${input.internalContext} ${input.customerFacingMessage}`)

  const { data, error } = await supabase
    .from('caye_escalations')
    .insert({
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      category: input.category,
      route_to: input.routeTo,
      customer_facing_message: input.customerFacingMessage,
      internal_context: input.internalContext,
      ping_summary: pingSummary,
      target_date: targetDate ? targetDate.toISOString().slice(0, 10) : null,
    })
    .select('id')
    .single()

  if (error || !data) {
    console.error('[escalation] insert failed:', error)
    return { escalationId: null }
  }

  if (input.conversationId) {
    await supabase
      .from('unified_conversations')
      .update({
        human_agent_enabled: true,
        human_agent_reason: `Escalation (${input.category}): ${pingSummary.slice(0, 120)}`,
        human_agent_marked_at: new Date().toISOString(),
      })
      .eq('id', input.conversationId)
    await supabase.from('unified_messages').insert({
      conversation_id: input.conversationId,
      channel_message_id: null,
      sender_type: 'business',
      content: `[Caye escalation — ${input.category} → ${input.routeTo}] ${input.internalContext}`,
      message_type: 'text',
      sent_at: new Date().toISOString(),
      status: 'sent',
      is_internal: true,
      metadata: {
        generated_by: 'caye',
        escalation_id: data.id,
        category: input.category,
        route_to: input.routeTo,
      },
    })
  }

  enqueueEscalationPings({
    workspaceId: input.workspaceId,
    escalationId: data.id,
    conversationId: input.conversationId,
    contactName: input.contactName,
    category: input.category,
    routeTo: input.routeTo,
    suggestedReply: input.customerFacingMessage,
    internalContext: input.internalContext,
    pingSummary,
  }).catch((err) => console.error('[escalation] enqueueEscalationPings failed:', err))

  return { escalationId: data.id }
}

/**
 * Webhook glue: when caye-reply returns an `escalate` decision, persist the
 * escalation + queue operator pings, then collapse to a plain `reply`
 * decision so the rest of the webhook's send/store path runs unchanged.
 *
 * Returns the original decision when it isn't an escalation.
 */
export async function applyEscalation(
  decision: CayeAutoReply,
  meta: { workspaceId: string; conversationId: string | null; contactName: string }
): Promise<Exclude<CayeAutoReply, { action: 'escalate' }>> {
  if (decision.action !== 'escalate') return decision

  await recordEscalation({
    workspaceId: meta.workspaceId,
    conversationId: meta.conversationId,
    contactName: meta.contactName,
    category: decision.category,
    routeTo: decision.routeTo,
    customerFacingMessage: decision.content,
    internalContext: decision.internalContext,
    pingSummary: decision.pingSummary,
  })

  return { action: 'reply', content: decision.content }
}

// Last-resort fallback only, for legacy escalation rows with no persisted
// ping_summary at all. Plain language on purpose — this can still reach an
// operator's WhatsApp directly, not just an internal log.
export function labelForCategory(category: EscalationCategory): string {
  switch (category) {
    case 'gap':
      return "Something I couldn't do myself"
    case 'policy':
      return 'A call I need you to make'
    case 'knowledge':
      return "A question I don't know the answer to"
    case 'sensitive':
      return 'Something private or sensitive'
  }
}
