/**
 * POST /api/webhooks/whatsapp
 *
 * Receives inbound WhatsApp messages from Meta's Cloud API webhook.
 * Returns 200 immediately after signature verification. Processing runs in the background.
 *
 * Assumption: the connected_accounts row for a WhatsApp channel must have
 *   channel_type = 'whatsapp'
 *   channel_account_id = the Meta phone_number_id for that number
 *   access_token = a valid Meta system user or page access token
 *   is_active = true
 *
 * Meta webhook registration:
 *   URL: https://<your-domain>/api/webhooks/whatsapp
 *   Verify token: META_WEBHOOK_VERIFY_TOKEN (env var)
 *   Subscribe to: messages
 */

import { NextRequest, NextResponse, after } from 'next/server'
import { createHmac } from 'crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { generateCayeAutoReply } from '@/lib/caye-reply'
import { enqueueHoldPing } from '@/lib/whatsapp/triggers'
import { applyEscalation } from '@/lib/whatsapp/escalation'
import { maybeRefreshContactProfile } from '@/lib/contact-profile'
import { syncBookingToCalendar } from '@/lib/calendar-sync'
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
      console.warn('[whatsapp webhook] Signature mismatch — rejecting')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Return 200 immediately; after() keeps the function alive until processing finishes
  after(
    processInboundWhatsApp(payload).catch(err =>
      console.error('[whatsapp webhook] Processing error:', err)
    )
  )

  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

// ─── Background processor ─────────────────────────────────────────────────────

interface WaMetadata {
  phone_number_id: string
  display_phone_number?: string
}

interface WaContact {
  profile: { name: string }
  wa_id: string
}

interface WaTextMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
}

interface WaValue {
  metadata: WaMetadata
  contacts?: WaContact[]
  messages?: WaTextMessage[]
}

async function processInboundWhatsApp(payload: Record<string, unknown>): Promise<void> {
  // Parse Meta webhook envelope: entry[0].changes[0].value
  const entry = (payload.entry as Record<string, unknown>[] | undefined)?.[0]
  const change = (entry?.changes as Record<string, unknown>[] | undefined)?.[0]
  const value = change?.value as WaValue | undefined

  if (!value) {
    console.warn('[whatsapp webhook] No value in payload — skipping')
    return
  }

  const { metadata, contacts, messages } = value
  const phone_number_id = metadata?.phone_number_id

  if (!phone_number_id) {
    console.warn('[whatsapp webhook] Missing phone_number_id — skipping')
    return
  }

  // Meta also sends delivery receipts with no messages array — ignore silently
  if (!messages || messages.length === 0) return

  const supabase = createServiceClient()

  // Workspace lookup by phone_number_id
  const { data: account } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('channel_type', 'whatsapp')
    .eq('channel_account_id', phone_number_id)
    .eq('is_active', true)
    .maybeSingle()

  if (!account) {
    console.warn(`[whatsapp webhook] No connected account for phone_number_id: ${phone_number_id}`)
    return
  }

  const workspaceId: string = account.user_id

  // Self-loop guard — skip if sender matches the business's own number stored in metadata
  const accountMeta = (account.metadata ?? {}) as Record<string, string>
  const businessPhone = accountMeta.business_phone ?? ''

  // Fetch AI config + voice profile in parallel
  let systemPrompt =
    'You are a helpful assistant. Reply to customer messages warmly and professionally.'

  const [{ data: aiConfig }, { data: customer }] = await Promise.all([
    supabase
      .from('workspace_ai_config')
      .select('system_prompt, ai_enabled')
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

  for (const message of messages) {
    const messageId = message.id
    const from = message.from
    const sentAt = new Date(Number(message.timestamp) * 1000).toISOString()
    const isTextMessage = message.type === 'text'
    const body = message.text?.body ?? ''

    // Self-loop guard
    if (businessPhone && from === businessPhone) {
      console.log('[whatsapp webhook] Self-sent message — skipping loop guard')
      continue
    }

    // Resolve customer name from contacts array
    const contact = contacts?.find(c => c.wa_id === from)
    const customerName = contact?.profile?.name ?? from

    // Upsert a contact row for this WhatsApp sender, keyed on
    // (workspace, channel, wa number) — mirrors the email webhook's
    // contact upsert (zoho-email/route.ts) so Caye's per-customer style
    // learning also works for the primary front-desk channel.
    const { data: contactRow, error: contactErr } = await supabase
      .from('contacts')
      .upsert(
        {
          customer_id: workspaceId,
          name: customerName,
          phone_number: from,
          channel_type: 'whatsapp',
          channel_id: from,
          first_message_at: sentAt,
          last_message_at: sentAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'customer_id,channel_type,channel_id', ignoreDuplicates: false }
      )
      .select('id')
      .single()

    if (contactErr) {
      console.warn('[whatsapp webhook] Contact upsert failed (continuing):', contactErr.message)
    }

    // Upsert conversation keyed on sender's WA number
    const { data: conversation, error: convErr } = await supabase
      .from('unified_conversations')
      .upsert(
        {
          connected_account_id: account.id,
          channel_type: 'whatsapp',
          channel_conversation_id: from,
          customer_name: customerName,
          customer_id: from,
          contact_id: contactRow?.id,
          status: 'open',
          last_message_at: sentAt,
          last_message_preview: isTextMessage ? body.slice(0, 100) : `[${message.type}]`,
          last_sender_type: 'customer',
          metadata: { wa_id: from, phone_number_id },
          ...(isTextMessage
            ? {}
            : { human_agent_enabled: true, human_agent_reason: 'Media message — needs human review' }),
        },
        { onConflict: 'connected_account_id,channel_conversation_id' }
      )
      .select('id, contact_id')
      .single()

    if (convErr || !conversation) {
      console.error('[whatsapp webhook] Conversation upsert failed:', convErr)
      continue
    }

    // Dedup check + first-message detection (run in parallel)
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
        content: isTextMessage ? body : `[${message.type} message]`,
        message_type: isTextMessage ? 'text' : message.type,
        sent_at: sentAt,
        status: 'delivered',
        metadata: { wa_id: from, phone_number_id },
      })
      if (inboundErr) {
        console.error('[whatsapp webhook] Inbound message insert failed:', inboundErr)
      } else if (conversation.contact_id) {
        // Fire-and-forget customer style learning — no-op when no contact
        // exists yet for this conversation (true today for social channels).
        maybeRefreshContactProfile(conversation.contact_id).catch(err =>
          console.error('[whatsapp webhook] Contact profile refresh failed:', err)
        )
      }
    }

    // Non-text messages get no AI reply — human agent flag already set above
    if (!isTextMessage || !body) continue

    if (aiConfig?.ai_enabled === false) {
      console.log(`[whatsapp webhook] AI disabled for workspace ${workspaceId} — skipping auto-reply`)
      continue
    }

    // Generate Caye response (reply or hold decision)
    let decision: Awaited<ReturnType<typeof generateCayeAutoReply>>
    try {
      decision = await generateCayeAutoReply(
        systemPrompt,
        {
          senderName: customerName,
          body,
          channel: 'whatsapp',
          isFirstMessage,
          workspaceId,
          conversationId: conversation.id,
          currentChannelMessageId: messageId,
        },
        voiceProfile
      )
    } catch (err) {
      console.error('[whatsapp webhook] AI reply generation failed:', err)
      continue
    }

    decision = await applyEscalation(decision, {
      workspaceId,
      conversationId: conversation.id,
      contactName: customerName,
    })

    if (decision.action === 'hold') {
      // Hold the conversation and leave an internal note for the owner
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
        metadata: {
          generated_by: 'caye',
          hold_reason: decision.reason,
          proposed_reply: decision.proposedReply ?? null,
        },
      })
      console.log(`[whatsapp webhook] Held for human: ${from} — ${decision.reason}`)
      // Fire-and-forget WhatsApp ping to the operator. Internally no-ops if
      // the workspace flag is off or the operator number isn't verified.
      enqueueHoldPing({
        workspaceId,
        conversationId: conversation.id,
        contactName: customerName,
        reason: decision.reason,
        proposedReply: decision.proposedReply,
        inboundBody: body,
        urgency: decision.urgency,
      }).catch((err) => console.error('[whatsapp webhook] enqueueHoldPing failed:', err))
      continue
    }

    // Send reply via Meta Cloud API
    try {
      await sendWhatsAppMessage(from, decision.content, phone_number_id, account.access_token)
    } catch (err) {
      console.error('[whatsapp webhook] WhatsApp send failed:', err)
      continue
    }

    // Store outbound message
    const { error: outboundErr } = await supabase.from('unified_messages').insert({
      conversation_id: conversation.id,
      channel_message_id: `caye_wa_${Date.now()}`,
      sender_type: 'business',
      content: decision.content,
      message_type: 'text',
      sent_at: new Date().toISOString(),
      status: 'sent',
      metadata: { is_automated: true, generated_by: 'caye', phone_number_id },
    })

    if (outboundErr) {
      console.error('[whatsapp webhook] Outbound message insert failed:', outboundErr)
    } else {
      await supabase
        .from('unified_conversations')
        .update({ last_sender_type: 'business', last_business_sender_kind: 'caye' })
        .eq('id', conversation.id)
    }

    if (decision.bookingId) {
      syncBookingToCalendar(workspaceId, decision.bookingId, 'upsert').catch(err =>
        console.error('[whatsapp webhook] Calendar sync failed:', err)
      )
      console.log(
        `[whatsapp webhook] Caye created booking ${decision.bookingId} for workspace ${workspaceId}`
      )
    }

    console.log(`[whatsapp webhook] Auto-reply sent to ${from} for workspace ${workspaceId}`)
  }
}
