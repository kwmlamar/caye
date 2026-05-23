/**
 * POST /api/webhooks/zoho-email
 *
 * Receives inbound email notifications from Zoho (via Zoho Flow or a direct webhook rule),
 * generates an AI reply using the workspace's system prompt, and sends it back via Zoho Mail.
 *
 * Returns 200 immediately after validating the payload. Processing runs after the
 * response is sent, via Next.js `after()` — this keeps the function context alive on
 * Vercel so the worker isn't killed before Caye finishes generating and sending the reply.
 *
 * Zoho webhook registration:
 *   URL: https://<your-domain>/api/webhooks/zoho-email
 *   Method: POST
 *   Content-Type: application/json
 *   Secret header: X-Zoho-Webhook-Token: <ZOHO_WEBHOOK_SECRET>
 */

import { NextRequest, NextResponse, after } from 'next/server'
import { createHmac } from 'crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { sendZohoReply } from '@/lib/email-ai'
import { generateCayeAutoReply } from '@/lib/caye-reply'
import { syncBookingToCalendar } from '@/lib/calendar-sync'
import type { VoiceProfile } from '@/lib/voice-profile'

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  // Accept both bare hex and "sha256=<hex>" prefixed forms
  return header === expected || header === `sha256=${expected}`
}

export async function POST(request: NextRequest) {
  const secret = process.env.ZOHO_WEBHOOK_SECRET

  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  if (secret) {
    const sig =
      request.headers.get('x-zoho-webhook-token') ||
      request.headers.get('x-webhook-secret') ||
      request.headers.get('x-hub-signature-256')
    if (!verifySignature(rawBody, sig, secret)) {
      console.warn('[zoho-email webhook] Signature mismatch — rejecting')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Return 200 immediately; process after response is sent.
  // `after()` keeps the Vercel function context alive so processing isn't cut off.
  after(async () => {
    try {
      await processInboundEmail(payload)
    } catch (err) {
      console.error('[zoho-email webhook] Processing error:', err)
    }
  })

  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

async function processInboundEmail(payload: Record<string, unknown>): Promise<void> {
  // Normalize across Zoho Flow and direct Zoho Mail webhook field name variants
  const messageId = String(
    payload.message_id || payload.messageId || payload.id || `zoho_${Date.now()}`
  )
  const threadId = String(payload.thread_id || payload.threadId || messageId)
  const subject = String(payload.subject || '(no subject)')
  const toRaw = String(
    payload.to_address || payload.toAddress || payload.to || ''
  ).trim()
  // Extract bare email from "Display Name <addr>" or "addr" formats
  const toAddress =
    toRaw.match(/<([^>]+)>/)?.[1]?.toLowerCase().trim() ||
    toRaw.toLowerCase().trim()
  const fromRaw = String(
    payload.from_address || payload.fromAddress || payload.from || ''
  ).trim()
  const fromName = String(payload.from_name || payload.fromName || fromRaw)
  const bodyRaw = String(
    payload.content || payload.textContent || payload.body || payload.htmlBody || payload.summary || ''
  )
  const body = bodyRaw.includes('<') ? htmlToPlainText(bodyRaw) : bodyRaw.trim()
  const sentAt = payload.received_time
    ? new Date(Number(payload.received_time)).toISOString()
    : new Date().toISOString()

  // Extract bare email address from "Display Name <addr>" or "addr" formats
  const fromEmail =
    fromRaw.match(/<([^>]+)>/)?.[1]?.toLowerCase().trim() ||
    fromRaw.toLowerCase().trim()

  if (!fromEmail || !toAddress) {
    console.warn('[zoho-email webhook] Missing from/to — skipping', { fromEmail, toAddress })
    return
  }

  const supabase = createServiceClient()

  // Resolve workspace by the email address messages were sent TO
  const { data: account } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('channel_type', 'email')
    .eq('is_active', true)
    .or(`channel_account_name.ilike.${toAddress},channel_username.ilike.${toAddress}`)
    .maybeSingle()

  if (!account) {
    console.warn(`[zoho-email webhook] No connected account matched toAddress: ${toAddress}`)
    return
  }

  const workspaceId: string = account.user_id

  // Self-loop guard — skip replies sent from the workspace's own address
  const ownEmail = (account.channel_account_name || '').toLowerCase().trim()
  if (fromEmail === ownEmail) {
    console.log('[zoho-email webhook] Self-sent message — skipping loop guard')
    return
  }

  // Fetch workspace AI system prompt and voice profile in parallel
  let systemPrompt =
    'You are a helpful assistant. Reply to customer emails warmly and professionally.'

  const [{ data: aiConfig }, { data: customer }] = await Promise.all([
    supabase
      .from('workspace_ai_config')
      .select('system_prompt')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    supabase
      .from('customers')
      .select('ai_voice_profile')
      .eq('id', workspaceId)
      .maybeSingle(),
  ])

  if (aiConfig?.system_prompt) {
    systemPrompt = aiConfig.system_prompt
  }

  const voiceProfile = (customer?.ai_voice_profile ?? undefined) as VoiceProfile | undefined

  // Upsert conversation keyed on threadId
  const { data: conversation, error: convErr } = await supabase
    .from('unified_conversations')
    .upsert(
      {
        connected_account_id: account.id,
        channel_type: 'email',
        channel_conversation_id: threadId,
        customer_name: fromName || fromEmail,
        customer_id: fromEmail,
        status: 'open',
        metadata: { subject, from: fromRaw, thread_id: threadId },
      },
      { onConflict: 'connected_account_id,channel_conversation_id' }
    )
    .select('id')
    .single()

  if (convErr || !conversation) {
    console.error('[zoho-email webhook] Conversation upsert failed:', convErr)
    return
  }

  // Dedup inbound message
  const { data: existing } = await supabase
    .from('unified_messages')
    .select('id')
    .eq('channel_message_id', messageId)
    .maybeSingle()

  if (!existing) {
    const { error: inboundErr } = await supabase.from('unified_messages').insert({
      conversation_id: conversation.id,
      channel_message_id: messageId,
      sender_type: 'customer',
      content: body || subject,
      message_type: 'text',
      sent_at: sentAt,
      status: 'delivered',
      metadata: {
        subject,
        from: fromRaw,
        zoho_message_id: messageId,
        zoho_thread_id: threadId,
      },
    })
    if (inboundErr) {
      console.error('[zoho-email webhook] Inbound message insert failed:', inboundErr)
    } else {
      await supabase
        .from('unified_conversations')
        .update({ last_sender_type: 'customer', last_message_at: sentAt, last_message_preview: (body || subject).slice(0, 100) })
        .eq('id', conversation.id)
    }
  }

  // Generate Caye response
  let decision: Awaited<ReturnType<typeof generateCayeAutoReply>>
  try {
    decision = await generateCayeAutoReply(
      systemPrompt,
      {
        senderName: fromName || fromEmail,
        body: body || subject,
        channel: 'email',
        subject,
        workspaceId,
        conversationId: conversation.id,
        senderEmail: fromEmail,
      },
      voiceProfile
    )
  } catch (err) {
    console.error('[zoho-email webhook] AI reply generation failed:', err)
    return
  }

  if (decision.action === 'hold') {
    await supabase
      .from('unified_conversations')
      .update({ human_agent_enabled: true, human_agent_reason: decision.reason })
      .eq('id', conversation.id)
    await supabase.from('unified_messages').insert({
      conversation_id: conversation.id,
      channel_message_id: null,
      sender_type: 'business',
      content: decision.note,
      message_type: 'text',
      sent_at: new Date().toISOString(),
      status: 'sent',
      is_internal: true,
      metadata: { generated_by: 'caye', hold_reason: decision.reason },
    })
    console.log(`[zoho-email webhook] Held for human: ${fromEmail} — ${decision.reason}`)
    return
  }

  // Send via Zoho
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`
  try {
    await sendZohoReply(fromEmail, replySubject, decision.content, threadId, workspaceId)
  } catch (err) {
    console.error('[zoho-email webhook] Zoho send failed:', err)
    return
  }

  // Store outbound message
  const replySentAt = new Date().toISOString()
  const { error: outboundErr } = await supabase.from('unified_messages').insert({
    conversation_id: conversation.id,
    channel_message_id: `caye_auto_${Date.now()}`,
    sender_type: 'business',
    content: decision.content,
    message_type: 'text',
    sent_at: replySentAt,
    status: 'sent',
    metadata: {
      subject: replySubject,
      is_automated: true,
      generated_by: 'caye',
    },
  })

  if (!outboundErr) {
    await supabase
      .from('unified_conversations')
      .update({ last_sender_type: 'business', last_business_sender_kind: 'caye', last_message_at: replySentAt, last_message_preview: decision.content.slice(0, 100) })
      .eq('id', conversation.id)
  }

  if (decision.bookingId) {
    syncBookingToCalendar(workspaceId, decision.bookingId, 'upsert').catch(err =>
      console.error('[zoho-email webhook] Calendar sync failed:', err)
    )
    console.log(
      `[zoho-email webhook] Caye created booking ${decision.bookingId} for workspace ${workspaceId}`
    )
  }

  console.log(`[zoho-email webhook] Auto-reply sent to ${fromEmail} for workspace ${workspaceId}`)
}
