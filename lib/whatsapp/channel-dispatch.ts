import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { sendMetaMessage } from '@/lib/meta-reply'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendZohoReply } from '@/lib/email-ai'

/**
 * Send `text` to the guest on the conversation's native channel and persist
 * the outbound message. Used by the `send` and `edit` action handlers to
 * ship the operator-approved (or operator-revised) draft.
 *
 * Mirrors the dispatch switch in app/api/messages/send/route.ts, but skips
 * the auth checks (caller already validated the operator's WhatsApp identity).
 */

export interface DispatchResult {
  success: true
  channelType: string
  messageId?: string
}

export async function dispatchOperatorReply(
  conversationId: string,
  text: string,
  senderLabel: 'caye-operator-wa' = 'caye-operator-wa'
): Promise<DispatchResult> {
  const supabase = createServiceClient()

  const { data: conv, error } = await supabase
    .from('unified_conversations')
    .select(
      `
      id, channel_type, customer_id, channel_conversation_id, metadata,
      connected_account:connected_accounts(
        id, user_id, channel_type, channel_account_id, access_token, metadata
      )
    `
    )
    .eq('id', conversationId)
    .single()

  if (error || !conv) {
    throw new Error(`conversation ${conversationId} not found: ${error?.message ?? ''}`)
  }

  const account = Array.isArray(conv.connected_account)
    ? conv.connected_account[0]
    : conv.connected_account
  if (!account) throw new Error('connected_account missing on conversation')

  const trimmed = text.trim()
  if (!trimmed) throw new Error('empty reply')

  switch (conv.channel_type) {
    case 'messenger':
    case 'instagram':
      await sendMetaMessage(conv.customer_id, trimmed, account.access_token)
      break
    case 'whatsapp':
      await sendWhatsAppMessage(
        conv.customer_id,
        trimmed,
        account.channel_account_id,
        account.access_token
      )
      break
    case 'email': {
      const meta = (conv.metadata ?? {}) as Record<string, string>
      const subj = meta.subject || '(no subject)'
      const replySubject = subj.startsWith('Re:') ? subj : `Re: ${subj}`
      await sendZohoReply(
        conv.customer_id,
        replySubject,
        trimmed,
        conv.channel_conversation_id,
        account.user_id
      )
      break
    }
    default:
      throw new Error(`unsupported channel: ${conv.channel_type}`)
  }

  const now = new Date().toISOString()
  const messageId = `op-wa-${Date.now()}`

  await supabase.from('unified_messages').insert({
    conversation_id: conversationId,
    channel_message_id: messageId,
    sender_type: 'business',
    content: trimmed,
    message_type: 'text',
    sent_at: now,
    status: 'sent',
    is_internal: false,
    metadata: { sent_by: senderLabel, generated_by: 'caye' },
  })

  await supabase
    .from('unified_conversations')
    .update({
      last_message_at: now,
      last_message_preview: trimmed.slice(0, 100),
      last_sender_type: 'business',
      last_business_sender_kind: 'human',
      human_agent_enabled: false,
      human_agent_reason: null,
    })
    .eq('id', conversationId)

  return { success: true, channelType: conv.channel_type, messageId }
}
