import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { sendMetaMessage } from '@/lib/meta-reply'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendZohoReply, sendZohoEmail } from '@/lib/email-ai'
import type { VoiceProfile } from '@/lib/voice-profile'
import { ensureTagline } from '@/lib/voice-profile'
import { resolveOpenEscalations } from '@/lib/caye-agent/tools/write-low/resolve-open-escalations'

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

export type OperatorReplySender = 'caye-operator-wa' | 'caye-dashboard'

export async function dispatchOperatorReply(
  conversationId: string,
  text: string,
  senderLabel: OperatorReplySender = 'caye-operator-wa'
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
  let outboundBody = trimmed
  const meta = (conv.metadata ?? {}) as Record<string, unknown>
  // Zoho's own id for the message we're about to send. Persisted below so a
  // later message on this thread (typically a follow-up nudge to a lead who
  // never replied) can reply against it and thread correctly — see
  // findReplyTargetZohoMessageId in lib/email-ai.ts.
  let zohoMessageId: string | null = null

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
      if (meta.hold_kind === 'outreach_first_touch') {
        // First-touch cold outreach — no real prior thread to reply into and
        // no inbound subject to inherit, so send a clean standalone email
        // with the subject the draft was created with (mirrors
        // app/api/messages/send/route.ts's outreach branch). No "Re:"
        // prefix and no tagline — those are reply-thread conventions that
        // don't apply to a cold open.
        const subject = (meta.subject as string) || 'Quick question'
        const sent = await sendZohoEmail(conv.customer_id, subject, trimmed, account.user_id)
        zohoMessageId = sent.messageId
        break
      }
      const subj = (meta.subject as string) || '(no subject)'
      const replySubject = subj.startsWith('Re:') ? subj : `Re: ${subj}`
      // The body here is Caye-composed (operator approved/revised the draft),
      // so the outbound-email tagline guarantee applies just like the
      // auto-reply paths — the draft usually predates ensureTagline and the
      // operator shouldn't have to remember to re-add the tagline when editing.
      const { data: workspaceRow } = await supabase
        .from('customers')
        .select('ai_voice_profile')
        .eq('id', account.user_id)
        .maybeSingle()
      outboundBody = ensureTagline(
        trimmed,
        (workspaceRow?.ai_voice_profile ?? undefined) as VoiceProfile | undefined
      )
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
    default:
      throw new Error(`unsupported channel: ${conv.channel_type}`)
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
    // sent_by carries the path (caye-operator-wa vs caye-dashboard) so future
    // audit can tell HOW the operator initiated the send. generated_by='caye'
    // signals "Caye composed the body" — voice-learning correctly excludes
    // these so Caye doesn't learn from her own output.
    // operator_approved=true distinguishes "operator authorized Caye to send"
    // from "Caye auto-replied on her own"; UI can surface a "via operator" tag.
    metadata: {
      sent_by: senderLabel,
      generated_by: 'caye',
      operator_approved: true,
      ...(zohoMessageId ? { zoho_message_id: zohoMessageId } : {}),
    },
  })
  if (messageInsertError) {
    throw new Error(`message sent but outbound message was not recorded: ${messageInsertError.message}`)
  }

  const { error: conversationUpdateError } = await supabase
    .from('unified_conversations')
    .update({
      last_message_at: now,
      last_message_preview: outboundBody.slice(0, 100),
      last_sender_type: 'business',
      // 'caye' not 'human' — Caye composed the body, even though the operator
      // authorized the send. Honest rendering: chat bubble should match other
      // Caye-authored messages so the operator can see at a glance "Caye
      // wrote this" vs "I typed this." The operator-approved flag in metadata
      // lets the UI surface a "via operator" subtitle/tag if desired.
      last_business_sender_kind: 'caye',
      human_agent_enabled: false,
      human_agent_reason: null,
    })
    .eq('id', conversationId)
  if (conversationUpdateError) {
    throw new Error(`message sent but conversation state was not recorded: ${conversationUpdateError.message}`)
  }

  // Also close out any open escalation row — otherwise it stays pending
  // forever and the "Needs review" stat card keeps counting a thread the
  // operator already replied to.
  await resolveOpenEscalations(supabase, conversationId)

  // First-touch cold-outreach send (create_outreach_leads / send_outreach_batch)
  // — flips the lead from 'draft' to 'sent' and stamps first_touch_sent_at
  // (mirrors app/api/messages/send/route.ts), which is what makes
  // outreach-nudge-scan's cron correctly find this lead 2 days later if it
  // goes quiet. .is('first_touch_sent_at', null) guards against a later
  // reply on the same thread re-stamping the timestamp.
  if (meta.source === 'outreach_leads' && meta.lead_id) {
    const { error: leadUpdateError } = await supabase
      .from('outreach_leads')
      .update({ status: 'sent', first_touch_sent_at: now })
      .eq('id', meta.lead_id as string)
      .is('first_touch_sent_at', null)
    if (leadUpdateError) {
      throw new Error(`message sent but outreach lead dispatch was not recorded: ${leadUpdateError.message}`)
    }
  }

  return { success: true, channelType: conv.channel_type, messageId }
}
