import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueEscalationPings } from './triggers'
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

  const { data, error } = await supabase
    .from('caye_escalations')
    .insert({
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      category: input.category,
      route_to: input.routeTo,
      customer_facing_message: input.customerFacingMessage,
      internal_context: input.internalContext,
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
        human_agent_reason: `Escalation (${input.category}): ${input.internalContext.slice(0, 120)}`,
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
  })

  return { action: 'reply', content: decision.content }
}
