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
import { sendZohoReply, sendZohoEmail } from '@/lib/email-ai'
import { resolveOpenEscalations } from '@/lib/caye-agent/tools/write-low/resolve-open-escalations'
import { maybeRefreshOwnerVoiceProfile } from '@/lib/owner-voice-learning'
import { maybeSuggestBusinessFacts } from '@/lib/business-fact-suggestions'

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

  if (!account) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // The connected_account's user_id IS the workspace id (customers.id == owner's
  // auth.users.id by design). Access is granted if the caller is either:
  //   (a) the owner themselves, or
  //   (b) an active member of that workspace via workspace_members.
  if (account.user_id !== user.id) {
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', account.user_id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership) {
      console.warn(
        `[messages/send] Forbidden: user ${user.id} has no access to workspace ${account.user_id} ` +
          `(conversation ${conversation_id})`
      )
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const text = content.trim()
  const now = new Date().toISOString()
  // Zoho's own id for this send, persisted below so a later message on the
  // same thread (e.g. a follow-up to a lead who never replied) can reply
  // against it — see findReplyTargetZohoMessageId in lib/email-ai.ts.
  let zohoMessageId: string | null = null

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
        if (meta.hold_kind === 'outreach_first_touch') {
          // First-touch cold outreach — there's no real prior thread to reply
          // into and no inbound subject to inherit, so send a clean standalone
          // email with the subject the draft was created with. Using
          // sendZohoReply here produced "Re: (no subject)" in practice.
          const subject = meta.subject || 'Quick question'
          const sent = await sendZohoEmail(conv.customer_id, subject, text, account.user_id)
          zohoMessageId = sent.messageId
        } else {
          const originalSubject = meta.subject || '(no subject)'
          const replySubject = originalSubject.startsWith('Re:')
            ? originalSubject
            : `Re: ${originalSubject}`
          // customer_id = sender email address, channel_conversation_id = Zoho thread ID
          const replySent = await sendZohoReply(
            conv.customer_id,
            replySubject,
            text,
            conv.channel_conversation_id,
            account.user_id
          )
          zohoMessageId = replySent.messageId
        }
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
      metadata: {
        sent_by: 'human',
        user_id: user.id,
        ...(zohoMessageId ? { zoho_message_id: zohoMessageId } : {}),
      },
    })
    .select()
    .single()

  if (insertErr) {
    console.error('[messages/send] Message insert failed:', insertErr)
    // Delivery already succeeded — return partial success so UI doesn't show "failed"
    return NextResponse.json({ success: true, message: null })
  }

  // Update conversation preview. Also clear the human_agent_enabled hold
  // flag — the owner is responding, so Caye should resume monitoring on
  // the customer's next message (she'll re-hold if the thread is still
  // outside her envelope).
  await supabase
    .from('unified_conversations')
    .update({
      last_message_at: now,
      last_message_preview: text.slice(0, 100),
      last_sender_type: 'business',
      last_business_sender_kind: 'human',
      human_agent_enabled: false,
      human_agent_reason: null,
    })
    .eq('id', conversation_id)

  // Also close out any open escalation row — otherwise it stays pending
  // forever (see resolveOpenEscalations) and the "Needs review" stat card
  // keeps counting a thread the owner already handled.
  await resolveOpenEscalations(supabase, conversation_id)

  // First-touch cold-outreach send (create_outreach_leads tool) — flips
  // the lead from 'draft' to 'sent' and stamps first_touch_sent_at, which
  // is what makes outreach-nudge-scan's cron correctly find this lead 2
  // days later if it goes quiet. .is('first_touch_sent_at', null) guards
  // against a later reply on the same thread re-stamping the timestamp.
  const convMeta = (conv.metadata ?? {}) as Record<string, unknown>
  if (convMeta.source === 'outreach_leads' && convMeta.lead_id) {
    await supabase
      .from('outreach_leads')
      .update({ status: 'sent', first_touch_sent_at: now })
      .eq('id', convMeta.lead_id as string)
      .is('first_touch_sent_at', null)
  }

  // Fire-and-forget owner voice learning. Re-extracts the voice profile
  // every 10 trusted-channel owner messages. Non-blocking — silently
  // logged on failure since voice learning is non-critical.
  maybeRefreshOwnerVoiceProfile(account.user_id, conv.channel_type).catch(err =>
    console.error('[messages/send] Owner voice refresh failed:', err)
  )

  // Fire-and-forget business-fact-candidate detection. Non-blocking — see
  // lib/business-fact-suggestions.ts for why this exists.
  maybeSuggestBusinessFacts(account.user_id, conversation_id, text).catch(err =>
    console.error('[messages/send] Business fact suggestion failed:', err)
  )

  return NextResponse.json({ success: true, message })
}
