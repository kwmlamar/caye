/**
 * POST /api/webhooks/messenger
 *
 * Receives inbound Facebook Messenger messages from Meta's webhook.
 * Returns 200 immediately after signature verification. Processing runs in the background.
 *
 * Assumption: the connected_accounts row for a Messenger channel must have
 *   channel_type = 'messenger'
 *   channel_account_id = the Facebook Page ID (event.recipient.id)
 *   access_token = a valid Meta page access token with pages_messaging permission
 *   is_active = true
 *
 * Each workspace must connect their Page via Settings — there is no env-var fallback.
 * If no connected_accounts row is found for the inbound recipient page ID, the message
 * is logged and dropped. Register the page through the Channels settings panel.
 *
 * Meta webhook registration:
 *   URL: https://<your-domain>/api/webhooks/messenger
 *   Verify token: META_WEBHOOK_VERIFY_TOKEN (env var)
 *   Subscribe to: messages
 */

import { NextRequest, NextResponse, after } from 'next/server'
import { createHmac } from 'crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { sendMetaMessage, fetchMetaSenderName } from '@/lib/meta-reply'
import { generateCayeAutoReply } from '@/lib/caye-reply'
import type { VoiceProfile } from '@/lib/voice-profile'

// ─── GET — webhook verification ──────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const mode = params.get('hub.mode')
  const token = params.get('hub.verify_token')
  const challenge = params.get('hub.challenge')

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge ?? '', { status: 200 })
  }

  return new NextResponse('Forbidden', { status: 403 })
}

// ─── POST — inbound messages ──────────────────────────────────────────────────

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  return header === expected
}

export async function POST(request: NextRequest) {
  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const secret = process.env.META_APP_SECRET
  if (secret) {
    const sig = request.headers.get('x-hub-signature-256')
    if (!verifySignature(rawBody, sig, secret)) {
      console.warn('[messenger webhook] Signature mismatch — rejecting')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (payload.object !== 'page') {
    return NextResponse.json({ status: 'ok' }, { status: 200 })
  }

  // Return 200 immediately; after() keeps the function alive until processing finishes
  after(
    processInboundMessenger(payload).catch(err =>
      console.error('[messenger webhook] Processing error:', err)
    )
  )

  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

// ─── Background processor ─────────────────────────────────────────────────────

interface MetaMessagingEvent {
  sender: { id: string }
  recipient: { id: string }
  timestamp: number
  message?: {
    mid: string
    text?: string
  }
}

interface MetaEntry {
  messaging?: MetaMessagingEvent[]
}

async function processInboundMessenger(payload: Record<string, unknown>): Promise<void> {
  const entries = payload.entry as MetaEntry[] | undefined
  if (!entries?.length) return

  const supabase = createServiceClient()

  for (const entry of entries) {
    const messagingEvents = entry.messaging ?? []

    for (const event of messagingEvents) {
      const senderId = event.sender?.id
      const recipientId = event.recipient?.id
      const messageId = event.message?.mid
      const body = event.message?.text
      const timestamp = event.timestamp

      if (!messageId || !body) continue
      if (senderId === recipientId) continue

      const { data: account } = await supabase
        .from('connected_accounts')
        .select('*')
        .eq('channel_type', 'messenger')
        .eq('channel_account_id', recipientId)
        .eq('is_active', true)
        .maybeSingle()

      if (!account) {
        console.warn(
          `[messenger webhook] No connected account for page: ${recipientId}. ` +
            'Connect this Page via Settings > Channels.'
        )
        continue
      }

      const workspaceId: string = account.user_id

      const [{ data: aiConfig }, { data: customer }, senderName] = await Promise.all([
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
        fetchMetaSenderName(senderId, account.access_token),
      ])

      const systemPrompt =
        aiConfig?.system_prompt ??
        'You are a helpful assistant. Reply to customer messages warmly and professionally.'

      const voiceProfile = (customer?.ai_voice_profile ?? undefined) as VoiceProfile | undefined

      // Meta delivers Messenger event timestamps in milliseconds
      const sentAt = new Date(timestamp).toISOString()
      const customerName = senderName ?? senderId

      const { data: conversation, error: convErr } = await supabase
        .from('unified_conversations')
        .upsert(
          {
            connected_account_id: account.id,
            channel_type: 'messenger',
            channel_conversation_id: senderId,
            customer_name: customerName,
            customer_id: senderId,
            status: 'open',
            last_message_at: sentAt,
            last_message_preview: body.slice(0, 100),
            last_sender_type: 'customer',
            metadata: { page_id: recipientId },
          },
          { onConflict: 'connected_account_id,channel_conversation_id' }
        )
        .select('id')
        .single()

      if (convErr || !conversation) {
        console.error('[messenger webhook] Conversation upsert failed:', convErr)
        continue
      }

      const [{ data: existing }, { count: priorCount }] = await Promise.all([
        supabase
          .from('unified_messages')
          .select('id')
          .eq('channel_message_id', messageId)
          .maybeSingle(),
        supabase
          .from('unified_messages')
          .select('*', { count: 'exact', head: true })
          .eq('conversation_id', conversation.id),
      ])

      const isFirstMessage = (priorCount ?? 0) === 0

      if (!existing) {
        const { error: inboundErr } = await supabase.from('unified_messages').insert({
          conversation_id: conversation.id,
          channel_message_id: messageId,
          sender_type: 'customer',
          content: body,
          message_type: 'text',
          sent_at: sentAt,
          status: 'delivered',
          metadata: { sender_id: senderId, page_id: recipientId },
        })
        if (inboundErr) {
          console.error('[messenger webhook] Inbound message insert failed:', inboundErr)
        }
      }

      let decision: Awaited<ReturnType<typeof generateCayeAutoReply>>
      try {
        decision = await generateCayeAutoReply(
          systemPrompt,
          { senderName: customerName, body, channel: 'messenger', isFirstMessage },
          voiceProfile
        )
      } catch (err) {
        console.error('[messenger webhook] AI reply generation failed:', err)
        continue
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
        console.log(`[messenger webhook] Held for human: ${senderId} — ${decision.reason}`)
        continue
      }

      try {
        await sendMetaMessage(senderId, decision.content, account.access_token)
      } catch (err) {
        console.error('[messenger webhook] Send failed:', err)
        continue
      }

      const { error: outboundErr } = await supabase.from('unified_messages').insert({
        conversation_id: conversation.id,
        channel_message_id: `caye_msng_${Date.now()}`,
        sender_type: 'business',
        content: decision.content,
        message_type: 'text',
        sent_at: new Date().toISOString(),
        status: 'sent',
        metadata: { is_automated: true, generated_by: 'caye', page_id: recipientId },
      })

      if (outboundErr) {
        console.error('[messenger webhook] Outbound message insert failed:', outboundErr)
      } else {
        await supabase
          .from('unified_conversations')
          .update({ last_sender_type: 'business', last_business_sender_kind: 'caye' })
          .eq('id', conversation.id)
      }

      console.log(
        `[messenger webhook] Auto-reply sent to ${senderId} for workspace ${workspaceId}`
      )
    }
  }
}
