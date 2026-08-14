import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { decideSalesInboundPolicy, type SalesInboundPolicy } from './inbound-policy'
import { recordSalesLifecycleEvent, type SalesLifecycleEvent } from './lifecycle'
import { buildSalesLeadContext, type SalesLeadContext } from './context'
import { bridgeSalesInboundToWork } from './opportunity-bridge'
import { classifySalesReplyIntent, type SalesReplyClassification } from './reply-intent'

export type SalesInboundHandling =
  | { disposition: 'eligible'; context: SalesLeadContext | null; replyIntent: SalesReplyClassification }
  | { disposition: 'ignore'; reason: string; context: SalesLeadContext | null }
  | { disposition: 'hold'; reason: string; context: SalesLeadContext | null }
  | { disposition: 'escalate'; message: string; reason: string; context: SalesLeadContext | null }

function lifecycleEventFor(policy: SalesInboundPolicy): SalesLifecycleEvent | null {
  if (policy.kind === 'human_reply') return 'human_reply_received'
  if (policy.kind === 'automated_ooo') return 'automated_reply_received'
  if (policy.kind === 'opt_out') return 'opted_out'
  if (policy.kind === 'bounce_or_delivery_failure') return 'bounce_or_delivery_failure'
  if (policy.kind === 'unknown') return 'inbound_unknown'
  return null
}

/** Shared ingestion stays outside Sales; this owns what an inbound means to acquisition. */
export async function handleSalesInbound(input: {
  workspaceId: string
  workspaceEmail?: string | null
  senderEmail?: string | null
  subject?: string | null
  body?: string | null
  conversationId?: string | null
  currentChannelMessageId?: string | null
  receivedAt?: string | null
}): Promise<SalesInboundHandling> {
  const policy = decideSalesInboundPolicy(input.subject, input.body, {
    senderEmail: input.senderEmail, workspaceEmail: input.workspaceEmail,
    synthetic: /^caye_|^manual_|^op-wa-/.test(input.currentChannelMessageId ?? ''),
  })
  const supabase = createServiceClient()
  const { data: leadByEmail } = await supabase.from('outreach_leads')
    .select('id').eq('workspace_id', input.workspaceId).eq('lead_email', input.senderEmail ?? '').maybeSingle()
  const { data: conversation } = input.conversationId
    ? await supabase.from('unified_conversations').select('metadata, last_sender_type, contact_id').eq('id', input.conversationId).maybeSingle()
    : { data: null }
  const linkedLeadId = (conversation?.metadata as Record<string, unknown> | null)?.lead_id
  const leadId = (leadByEmail as { id: string } | null)?.id ??
    (policy.kind === 'bounce_or_delivery_failure' && typeof linkedLeadId === 'string' ? linkedLeadId : null)
  const event = lifecycleEventFor(policy)
  const eventRoot = input.currentChannelMessageId ?? `${input.conversationId}:${policy.kind}`
  if (leadId && event) await recordSalesLifecycleEvent({
    workspaceId: input.workspaceId, leadId, event, eventKey: `inbound:${eventRoot}:${event}`,
  })
  if (policy.kind === 'internal' || policy.kind === 'automated_ooo' || policy.kind === 'opt_out' || policy.kind === 'bounce_or_delivery_failure') {
    return { disposition: 'ignore', reason: policy.kind, context: null }
  }
  if (policy.kind === 'unknown') return { disposition: 'hold', reason: policy.reason, context: null }
  if (policy.kind === 'deterministic_escalation') {
    if (leadId) await recordSalesLifecycleEvent({
      workspaceId: input.workspaceId, leadId, event: 'escalated',
      eventKey: `inbound:${input.currentChannelMessageId ?? `${input.conversationId}:escalation`}:escalated`,
      reason: policy.reason,
    })
    return { disposition: 'escalate', message: policy.message, reason: policy.reason, context: null }
  }
  let context: SalesLeadContext | null = null
  const contactId = typeof conversation?.contact_id === 'string' ? conversation.contact_id : null
  if (leadId && contactId) {
    try {
      // This deliberately runs after lifecycle normalization. It is
      // idempotent in the database, so a provider replay can finish a prior
      // bridge attempt without duplicating the relationship or evidence.
      await bridgeSalesInboundToWork({
        workspaceId: input.workspaceId, contactId, leadId,
        conversationId: input.conversationId, providerMessageId: input.currentChannelMessageId,
        body: input.body, observedAt: input.receivedAt ?? undefined,
      })
    } catch (err) {
      // Opportunity coordination must not prevent a valid prospect reply;
      // the stable inbound source id makes a provider replay safe to retry.
      console.error('[sales/inbound] relationship bridge failed:', err)
    }
  }
  if (leadId) {
    try {
      context = await buildSalesLeadContext({ workspaceId: input.workspaceId, leadId, conversationLastSenderType: conversation?.last_sender_type })
    } catch (err) {
      // Prompt context was best-effort before this boundary existed; preserve
      // the ability to answer a valid Sales reply when its history is unreadable.
      console.error('[sales/inbound] lead context failed:', err)
    }
  }
  return { disposition: 'eligible', context, replyIntent: classifySalesReplyIntent(input.body) }
}
