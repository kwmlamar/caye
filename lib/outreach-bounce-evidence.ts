import 'server-only'
import { createServiceClient } from './supabase-server'
import { bouncedRecipientFromNotification } from './sales/inbound-policy'
import { recordSalesLifecycleEvent } from './sales/lifecycle'

type Receipt = { id: string; lead_id: string; recipient_email: string; provider_message_id: string | null }

export type BounceAttributionStatus = 'outbound_attributed' | 'recipient_attributed' | 'ambiguous' | 'unmatched'

export interface BounceAttribution {
  recipientEmail: string | null
  originalProviderMessageId: string | null
  status: BounceAttributionStatus
  reason: string
  receipt: Receipt | null
  leadId: string | null
}

/** Only standard DSN header fields are evidence. Free-form quoted text is not. */
export function originalProviderMessageIdFromNotification(body: string | null | undefined): string | null {
  if (!body) return null
  const match = body.match(/(?:original-message-id|x-original-message-id)\s*:\s*<?([^\s<>]+)>?/i)
  return match?.[1]?.trim() || null
}

export function attributeBounce(input: {
  recipientEmail: string | null
  originalProviderMessageId: string | null
  receiptsByProviderId: Receipt[]
  receiptsByRecipient: Receipt[]
  leadIdByRecipient: string | null
}): BounceAttribution {
  const { recipientEmail, originalProviderMessageId, receiptsByProviderId, receiptsByRecipient, leadIdByRecipient } = input
  if (receiptsByProviderId.length === 1) {
    const receipt = receiptsByProviderId[0]
    if (recipientEmail && receipt.recipient_email.toLowerCase() !== recipientEmail) {
      return { recipientEmail: null, originalProviderMessageId, status: 'ambiguous', reason: 'DSN recipient conflicts with provider-message receipt.', receipt: null, leadId: null }
    }
    return { recipientEmail: receipt.recipient_email.toLowerCase(), originalProviderMessageId, status: 'outbound_attributed', reason: 'Matched DSN provider message identifier to one outbound receipt.', receipt, leadId: receipt.lead_id }
  }
  if (receiptsByProviderId.length > 1) {
    return { recipientEmail: null, originalProviderMessageId, status: 'ambiguous', reason: 'Provider message identifier matched multiple outbound receipts.', receipt: null, leadId: null }
  }
  if (!recipientEmail) {
    return { recipientEmail: null, originalProviderMessageId, status: 'ambiguous', reason: 'DSN did not contain an explicit failed recipient.', receipt: null, leadId: null }
  }
  const receiptLeadIds = new Set(receiptsByRecipient.map((receipt) => receipt.lead_id))
  if (receiptLeadIds.size > 1 || (leadIdByRecipient && receiptLeadIds.size === 1 && !receiptLeadIds.has(leadIdByRecipient))) {
    return { recipientEmail: null, originalProviderMessageId, status: 'ambiguous', reason: 'Recipient maps to conflicting outbound/lead evidence.', receipt: null, leadId: null }
  }
  if (receiptsByRecipient.length === 1) {
    const receipt = receiptsByRecipient[0]
    return { recipientEmail, originalProviderMessageId, status: 'outbound_attributed', reason: 'Matched explicit DSN recipient to one outbound receipt.', receipt, leadId: receipt.lead_id }
  }
  if (leadIdByRecipient) {
    return { recipientEmail, originalProviderMessageId, status: 'recipient_attributed', reason: 'Matched explicit DSN recipient to one workspace lead.', receipt: null, leadId: leadIdByRecipient }
  }
  return { recipientEmail, originalProviderMessageId, status: 'unmatched', reason: 'Explicit DSN recipient has no workspace outreach lead.', receipt: null, leadId: null }
}

/** Persist a minimal receipt after an existing campaign send succeeds. */
export async function ensureOutreachOutboundReceipt(input: { workspaceId: string; conversationId: string; channelMessageId: string }): Promise<void> {
  const db = createServiceClient()
  const [{ data: message, error: messageError }, { data: conversation, error: conversationError }] = await Promise.all([
    db.from('unified_messages').select('id,metadata,sent_at').eq('conversation_id', input.conversationId).eq('channel_message_id', input.channelMessageId).maybeSingle(),
    db.from('unified_conversations').select('customer_id,channel_type,metadata').eq('id', input.conversationId).maybeSingle(),
  ])
  if (messageError) throw new Error(messageError.message)
  if (conversationError) throw new Error(conversationError.message)
  const meta = (conversation?.metadata ?? {}) as Record<string, unknown>
  const touchKind = meta.hold_kind === 'outreach_first_touch' ? 'first_touch' : meta.hold_kind === 'outreach_followup' ? 'followup' : null
  if (!message || !conversation || meta.source !== 'outreach_leads' || typeof meta.lead_id !== 'string' || !touchKind || conversation.channel_type !== 'email') return
  const messageMeta = (message.metadata ?? {}) as Record<string, unknown>
  const { error } = await db.from('caye_outreach_outbound_receipts').upsert({
    workspace_id: input.workspaceId, lead_id: meta.lead_id, unified_message_id: message.id,
    recipient_email: String(conversation.customer_id).toLowerCase(), touch_kind: touchKind,
    provider: 'zoho', provider_message_id: typeof messageMeta.zoho_message_id === 'string' ? messageMeta.zoho_message_id : null,
    sent_at: message.sent_at,
  }, { onConflict: 'unified_message_id' })
  if (error) throw new Error(`could not persist outreach outbound receipt: ${error.message}`)
}

/**
 * Apply one claimed DSN. The lifecycle event is keyed by its durable inbound
 * message ID, and the database RPC serializes insertion with safety pausing.
 */
export async function recordAttributedOutreachBounce(input: {
  workspaceId: string
  inboundMessageId: string
  inboundProviderMessageId: string
  body: string | null | undefined
  occurredAt: string
}): Promise<{ recorded: boolean; tripped: boolean; count?: number; windowHours?: number; attribution: BounceAttribution }> {
  const db = createServiceClient()
  const recipientEmail = bouncedRecipientFromNotification(input.body)
  const originalProviderMessageId = originalProviderMessageIdFromNotification(input.body)
  const [{ data: byProvider }, { data: byRecipient }, { data: lead }] = await Promise.all([
    originalProviderMessageId
      ? db.from('caye_outreach_outbound_receipts').select('id,lead_id,recipient_email,provider_message_id').eq('workspace_id', input.workspaceId).eq('provider_message_id', originalProviderMessageId)
      : Promise.resolve({ data: [] as Receipt[] }),
    recipientEmail
      ? db.from('caye_outreach_outbound_receipts').select('id,lead_id,recipient_email,provider_message_id').eq('workspace_id', input.workspaceId).eq('recipient_email', recipientEmail)
      : Promise.resolve({ data: [] as Receipt[] }),
    recipientEmail
      ? db.from('outreach_leads').select('id').eq('workspace_id', input.workspaceId).eq('lead_email', recipientEmail).maybeSingle()
      : Promise.resolve({ data: null as { id: string } | null }),
  ])
  const attribution = attributeBounce({ recipientEmail, originalProviderMessageId, receiptsByProviderId: (byProvider ?? []) as Receipt[], receiptsByRecipient: (byRecipient ?? []) as Receipt[], leadIdByRecipient: lead?.id ?? null })
  let suppressedAt: string | null = null
  if (attribution.leadId && attribution.recipientEmail) {
    await recordSalesLifecycleEvent({
      workspaceId: input.workspaceId, leadId: attribution.leadId, event: 'bounce_or_delivery_failure',
      eventKey: `inbound:${input.inboundProviderMessageId}:bounce_or_delivery_failure`,
      at: input.occurredAt, reason: 'deterministically_attributed_bounce',
    })
    suppressedAt = new Date().toISOString()
  }
  const { data, error } = await db.rpc('record_outreach_bounce', {
    p_workspace_id: input.workspaceId, p_inbound_message_id: input.inboundMessageId,
    p_inbound_provider_message_id: input.inboundProviderMessageId,
    p_outbound_receipt_id: attribution.receipt?.id ?? null, p_lead_id: attribution.leadId,
    p_recipient_email: attribution.recipientEmail, p_provider: 'zoho',
    p_bounce_classification: 'delivery_failure', p_attribution_status: attribution.status,
    p_attribution_reason: attribution.reason, p_recipient_suppressed_at: suppressedAt,
    p_occurred_at: input.occurredAt,
  })
  if (error) throw new Error(`could not record outreach bounce: ${error.message}`)
  const result = (data ?? {}) as { recorded?: boolean; tripped?: boolean; count?: number; window_hours?: number }
  return { recorded: result.recorded === true, tripped: result.tripped === true, count: result.count, windowHours: result.window_hours, attribution }
}
