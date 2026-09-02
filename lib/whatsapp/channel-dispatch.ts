import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { sendMetaMessage } from '@/lib/meta-reply'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendZohoReply, sendZohoEmail } from '@/lib/email-ai'
import type { VoiceProfile } from '@/lib/voice-profile'
import { ensureTagline } from '@/lib/voice-profile'
import { resolveOpenEscalations } from '@/lib/caye-agent/tools/write-low/resolve-open-escalations'
import { recordSalesLifecycleEvent } from '@/lib/sales/lifecycle'
import { sanitizeHumanFacingText } from '@/lib/human-facing-voice'

export interface DispatchResult {
  success: true
  channelType: string
  messageId?: string
  deduped?: boolean
}

export class DispatchAmbiguousError extends Error {
  readonly definitelySent: boolean
  constructor(message: string, definitelySent: boolean) {
    super(message)
    this.name = 'DispatchAmbiguousError'
    this.definitelySent = definitelySent
  }
}

export type OperatorReplySender = 'caye-operator-wa' | 'caye-dashboard' | 'caye-frontdesk-agent' | 'caye-outreach-autonomous'

export async function dispatchOperatorReply(
  conversationId: string,
  text: string,
  senderLabel: OperatorReplySender = 'caye-operator-wa',
  idempotencyKey?: string
): Promise<DispatchResult> {
  const supabase = createServiceClient()

  if (idempotencyKey) {
    const { data: existingSend } = await supabase
      .from('unified_messages')
      .select('channel_message_id, metadata')
      .eq('conversation_id', conversationId)
      .contains('metadata', { idempotency_key: idempotencyKey })
      .maybeSingle()
    if (existingSend) {
      const meta = (existingSend.metadata ?? {}) as Record<string, unknown>
      return {
        success: true,
        channelType: typeof meta.idempotency_channel === 'string' ? meta.idempotency_channel : 'unknown',
        messageId: existingSend.channel_message_id ?? undefined,
        deduped: true,
      }
    }
  }

  const { data: conv, error } = await supabase
    .from('unified_conversations')
    .select(`
      id, channel_type, customer_id, channel_conversation_id, metadata,
      connected_account:connected_accounts(
        id, user_id, channel_type, channel_account_id, access_token, metadata
      )
    `)
    .eq('id', conversationId)
    .single()

  if (error || !conv) {
    throw new Error(`conversation ${conversationId} not found: ${error?.message ?? ''}`)
  }

  const account = Array.isArray(conv.connected_account)
    ? conv.connected_account[0]
    : conv.connected_account
  if (!account) throw new Error('connected_account missing on conversation')

  const sanitizedText = sanitizeHumanFacingText(text)
  if (!sanitizedText) throw new Error('empty reply')
  let outboundBody = sanitizedText
  const meta = (conv.metadata ?? {}) as Record<string, unknown>
  let zohoMessageId: string | null = null

  if (!['messenger', 'instagram', 'whatsapp', 'email'].includes(conv.channel_type)) {
    throw new Error(`unsupported channel: ${conv.channel_type}`)
  }

  try {
    switch (conv.channel_type) {
      case 'messenger':
      case 'instagram':
        await sendMetaMessage(conv.customer_id, outboundBody, account.access_token)
        break
      case 'whatsapp':
        await sendWhatsAppMessage(
          conv.customer_id,
          outboundBody,
          account.channel_account_id,
          account.access_token
        )
        break
      case 'email': {
        if (meta.hold_kind === 'outreach_first_touch') {
          const subject = sanitizeHumanFacingText((meta.subject as string) || 'Quick question')
          const sent = await sendZohoEmail(conv.customer_id, subject, outboundBody, account.user_id)
          zohoMessageId = sent.messageId
          break
        }
        const subj = sanitizeHumanFacingText((meta.subject as string) || '(no subject)')
        const replySubject = subj.startsWith('Re:') ? subj : `Re: ${subj}`
        const { data: workspaceRow } = await supabase
          .from('customers')
          .select('ai_voice_profile')
          .eq('id', account.user_id)
          .maybeSingle()
        outboundBody = sanitizeHumanFacingText(ensureTagline(
          outboundBody,
          (workspaceRow?.ai_voice_profile ?? undefined) as VoiceProfile | undefined
        ))
        const replySent = await sendZohoReply(
          conv.customer_id,
          replySubject,
          outboundBody,
          conv.channel_conversation_id,
          account.user_id
        )
        zohoMessageId = replySent.messageId
        break
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new DispatchAmbiguousError(`provider send failed or its outcome is unknown: ${msg}`, false)
  }

  const now = new Date().toISOString()
  const messageId = `op-wa-${Date.now()}`

  const { error: messageInsertError } = await supabase.from('unified_messages').insert({
    conversation_id: conversationId,
    channel_message_id: messageId,
    sender_type: 'business',
    content: outboundBody,
    message_type: 'text',
    sent_at: now,
    status: 'sent',
    is_internal: false,
    metadata: {
      sent_by: senderLabel,
      generated_by: 'caye',
      operator_approved: senderLabel !== 'caye-outreach-autonomous',
      ...(senderLabel === 'caye-outreach-autonomous' && meta.autonomy && typeof meta.autonomy === 'object'
        ? { autonomy: meta.autonomy }
        : {}),
      ...(zohoMessageId ? { zoho_message_id: zohoMessageId } : {}),
      ...(idempotencyKey
        ? { idempotency_key: idempotencyKey, idempotency_channel: conv.channel_type }
        : {}),
    },
  })
  if (messageInsertError) {
    throw new DispatchAmbiguousError(`message sent but outbound message was not recorded: ${messageInsertError.message}`, true)
  }

  const { error: conversationUpdateError } = await supabase
    .from('unified_conversations')
    .update({
      last_message_at: now,
      last_message_preview: outboundBody.slice(0, 100),
      last_sender_type: 'business',
      last_business_sender_kind: 'caye',
      human_agent_enabled: false,
      human_agent_reason: null,
    })
    .eq('id', conversationId)
  if (conversationUpdateError) {
    throw new DispatchAmbiguousError(`message sent but conversation state was not recorded: ${conversationUpdateError.message}`, true)
  }

  try {
    await resolveOpenEscalations(supabase, conversationId)
    if (meta.source === 'outreach_leads' && typeof meta.lead_id === 'string' &&
        (meta.hold_kind === 'outreach_first_touch' || meta.hold_kind === 'outreach_followup')) {
      await recordSalesLifecycleEvent({
        workspaceId: account.user_id,
        leadId: meta.lead_id,
        event: meta.hold_kind === 'outreach_first_touch' ? 'first_touch_sent' : 'followup_sent',
        eventKey: `outbound:${messageId}`,
        at: now,
      })
    }
  } catch (followUpErr) {
    console.error('[channel-dispatch] post-send bookkeeping failed (send itself already succeeded):', followUpErr)
  }

  return { success: true, channelType: conv.channel_type, messageId, deduped: idempotencyKey ? false : undefined }
}
