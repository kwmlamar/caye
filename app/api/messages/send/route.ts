/**
 * POST /api/messages/send
 *
 * Sends a manual reply from the business owner via the Caye inbox.
 * Dispatches to the correct channel API (Messenger, Instagram, WhatsApp, Zoho email)
 * based on the conversation's channel_type, then persists the outbound message.
 *
 * Auth: expects `Authorization: Bearer <supabase-access-token>` header.
 * The token's user ID must match the connected_account.user_id for the conversation.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { sendMetaMessage } from '@/lib/meta-reply'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendZohoReply } from '@/lib/email-ai'
import { maybeRefreshOwnerVoiceProfile } from '@/lib/owner-voice-learning'

export async function POST(request: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const authHeader = request.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return NextResponse.json({ error: 'Missing auth token' }, { status: 401 })
  }

  const supabase = createServiceClient()

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Body ────────────────────────────────────────────────────────────────────
  let body: { conversation_id?: string; content?: string; message_type?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { conversation_id, content } = body
  if (!conversation_id || !content?.trim()) {
    return NextResponse.json({ error: 'conversation_id and content are required' }, { status: 400 })
  }

  // ── Fetch conversation + account (ownership check baked in) ─────────────────
  const { data: conv, error: convErr } = await supabase
    .from('unified_conversations')
    .select(`
      id, channel_type, customer_id, channel_conversation_id, metadata,
      connected_account:connected_accounts(
        id, user_id, channel_type, channel_account_id, access_token, metadata
      )
    `)
    .eq('id', conversation_id)
    .single()

  if (convErr || !conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const account = Array.isArray(conv.connected_account)
    ? conv.connected_account[0]
    : conv.connected_account

  if (!account || account.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const text = content.trim()
  const now = new Date().toISOString()

  // ── Dispatch to channel ─────────────────────────────────────────────────────
  try {
    switch (conv.channel_type) {
      case 'messenger':
      case 'instagram': {
        // customer_id = page-scoped sender ID (PSID)
        await sendMetaMessage(conv.customer_id, text, account.access_token)
        break
      }

      case 'whatsapp': {
        // customer_id = WA phone number, channel_account_id = phone_number_id
        await sendWhatsAppMessage(
          conv.customer_id,
          text,
          account.channel_account_id,
          account.access_token
        )
        break
      }

      case 'email': {
        const meta = (conv.metadata ?? {}) as Record<string, string>
        const originalSubject = meta.subject || '(no subject)'
        const replySubject = originalSubject.startsWith('Re:')
          ? originalSubject
          : `Re: ${originalSubject}`
        // customer_id = sender email address, channel_conversation_id = Zoho thread ID
        await sendZohoReply(
          conv.customer_id,
          replySubject,
          text,
          conv.channel_conversation_id,
          account.user_id
        )
        break
      }

      default:
        return NextResponse.json(
          { error: `Unsupported channel: ${conv.channel_type}` },
          { status: 422 }
        )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[messages/send] Channel send failed (${conv.channel_type}):`, msg)
    return NextResponse.json({ error: `Failed to deliver message: ${msg}` }, { status: 502 })
  }

  // ── Persist outbound message ────────────────────────────────────────────────
  const { data: message, error: insertErr } = await supabase
    .from('unified_messages')
    .insert({
      conversation_id,
      channel_message_id: `manual_${Date.now()}`,
      sender_type: 'business',
      content: text,
      message_type: 'text',
      sent_at: now,
      status: 'sent',
      is_internal: false,
      metadata: { sent_by: 'human', user_id: user.id },
    })
    .select()
    .single()

  if (insertErr) {
    console.error('[messages/send] Message insert failed:', insertErr)
    // Delivery already succeeded — return partial success so UI doesn't show "failed"
    return NextResponse.json({ success: true, message: null })
  }

  // Update conversation preview
  await supabase
    .from('unified_conversations')
    .update({
      last_message_at: now,
      last_message_preview: text.slice(0, 100),
      last_sender_type: 'business',
      last_business_sender_kind: 'human',
    })
    .eq('id', conversation_id)

  // Fire-and-forget owner voice learning. Re-extracts the voice profile
  // every 10 trusted-channel owner messages. Non-blocking — silently
  // logged on failure since voice learning is non-critical.
  maybeRefreshOwnerVoiceProfile(account.user_id, conv.channel_type).catch(err =>
    console.error('[messages/send] Owner voice refresh failed:', err)
  )

  return NextResponse.json({ success: true, message })
}
