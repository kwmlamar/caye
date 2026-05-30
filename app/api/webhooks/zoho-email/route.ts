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
import { enqueueHoldPing } from '@/lib/whatsapp/triggers'
import { syncBookingToCalendar } from '@/lib/calendar-sync'
import type { VoiceProfile } from '@/lib/voice-profile'
import { maybeRefreshContactProfile } from '@/lib/contact-profile'
import { htmlToPlainText } from '@/lib/email-text'

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
  // htmlToPlainText now handles plain text input too (it just no-ops on
  // tag-stripping) AND strips quoted-reply chains in both cases.
  const body = htmlToPlainText(bodyRaw)
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

  // Upsert a contact row for this email sender so per-customer learning has
  // somewhere to live. Keyed on (workspace, lowercase email) — the partial
  // unique index `contacts_email_workspace_unique` enforces dedup.
  const nowISO = new Date().toISOString()
  const { data: contactRow, error: contactErr } = await supabase
    .from('contacts')
    .upsert(
      {
        customer_id: workspaceId,
        email: fromEmail,
        name: fromName || fromEmail,
        channel_type: 'email',
        channel_id: fromEmail,
        first_message_at: sentAt,
        last_message_at: sentAt,
        updated_at: nowISO,
      },
      { onConflict: 'customer_id,email', ignoreDuplicates: false }
    )
    .select('id')
    .single()

  if (contactErr) {
    console.warn('[zoho-email webhook] Contact upsert failed (continuing):', contactErr.message)
  }

  // Find-or-create conversation by customer email (NOT by threadId).
  //
  // Previously keyed on threadId — same human across multiple Zoho threads
  // (web3forms submission, direct reply, Caye-initiated outbound that started
  // a new thread) produced N separate conversations. The Stallings 2026-05-29
  // case had 3 rows for jdstallings@protonmail.com. See
  // Clients/bimini-island-tours.md + lib/services/resolve-tier.ts.
  //
  // Rule: one conversation per (connected_account, email). Meta channels
  // (WA/IG/Messenger) keep threadId-based dedup since per-channel identity
  // is already stable there.
  let conversation: { id: string }
  const { data: existingConv } = await supabase
    .from('unified_conversations')
    .select('id, metadata')
    .eq('connected_account_id', account.id)
    .eq('channel_type', 'email')
    .eq('customer_id', fromEmail)
    .maybeSingle()

  if (existingConv) {
    const existingMeta = (existingConv.metadata ?? {}) as Record<string, unknown>
    const existingThreads = (existingMeta.related_thread_ids as string[] | undefined) ?? [existingMeta.thread_id as string | undefined].filter(Boolean) as string[]
    const relatedThreads = Array.from(new Set([...existingThreads, threadId]))
    await supabase
      .from('unified_conversations')
      .update({
        contact_id: contactRow?.id ?? null,
        metadata: {
          ...existingMeta,
          subject: existingMeta.subject ?? subject,
          from: existingMeta.from ?? fromRaw,
          thread_id: existingMeta.thread_id ?? threadId,
          related_thread_ids: relatedThreads,
        },
      })
      .eq('id', existingConv.id)
    conversation = { id: existingConv.id }
  } else {
    const { data: created, error: convErr } = await supabase
      .from('unified_conversations')
      .insert({
        connected_account_id: account.id,
        channel_type: 'email',
        channel_conversation_id: threadId,
        customer_name: fromName || fromEmail,
        customer_id: fromEmail,
        contact_id: contactRow?.id ?? null,
        status: 'open',
        metadata: { subject, from: fromRaw, thread_id: threadId, related_thread_ids: [threadId] },
      })
      .select('id')
      .single()

    if (convErr || !created) {
      console.error('[zoho-email webhook] Conversation insert failed:', convErr)
      return
    }
    conversation = created
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

      // Fire-and-forget customer style learning. Never blocks the reply path.
      if (contactRow?.id) {
        maybeRefreshContactProfile(contactRow.id).catch(err =>
          console.error('[zoho-email webhook] Contact profile refresh failed:', err)
        )
      }
    }
  }

  if (aiConfig?.ai_enabled === false) {
    console.log(`[zoho-email webhook] AI disabled for workspace ${workspaceId} — skipping auto-reply`)
    return
  }

  // Active-operator guard: if the owner has manually replied on this thread
  // recently (typed directly in Zoho or sent via Caye UI), they're actively
  // engaged. Hold instead of autopiloting to avoid competing or contradictory
  // replies on top of their work.
  //
  // Surfaced 2026-05-30: 95 human_via_external vs 16 caye_autopilot messages
  // across the inbox — without this gate Caye and the owner race on every
  // thread the owner touches outside Caye UI.
  const HUMAN_ACTIVE_WINDOW_MS = 60 * 60 * 1000 // 60 minutes
  const { data: lastBizMsg } = await supabase
    .from('unified_messages')
    .select('sent_at, metadata, sender_attribution')
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'business')
    .eq('is_internal', false)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (lastBizMsg) {
    const lastMeta = (lastBizMsg.metadata ?? {}) as Record<string, unknown>
    const isHumanLast =
      lastBizMsg.sender_attribution === 'human_via_external' ||
      lastBizMsg.sender_attribution === 'human_via_caye' ||
      lastMeta.sent_by === 'human' ||
      lastMeta.source === 'zoho_sent'
    const ageMs = Date.now() - new Date(lastBizMsg.sent_at).getTime()
    if (isHumanLast && ageMs < HUMAN_ACTIVE_WINDOW_MS) {
      const ageMin = Math.round(ageMs / 60000)
      await supabase
        .from('unified_conversations')
        .update({
          human_agent_enabled: true,
          human_agent_reason: `Owner replied directly ${ageMin}m ago — Caye paused on this thread`,
        })
        .eq('id', conversation.id)
      console.log(
        `[zoho-email webhook] Skipping autopilot — owner active on this thread ` +
        `(last human reply ${ageMin}m ago, within ${HUMAN_ACTIVE_WINDOW_MS / 60000}m window)`
      )
      return
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
        currentChannelMessageId: messageId,
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
      metadata: {
        generated_by: 'caye',
        hold_reason: decision.reason,
        proposed_reply: decision.proposedReply ?? null,
      },
    })
    console.log(`[zoho-email webhook] Held for human: ${fromEmail} — ${decision.reason}`)
    enqueueHoldPing({
      workspaceId,
      conversationId: conversation.id,
      contactName: fromName || fromEmail,
      reason: decision.reason,
      proposedReply: decision.proposedReply,
      inboundBody: body,
      urgency: decision.urgency,
    }).catch((err) => console.error('[zoho-email webhook] enqueueHoldPing failed:', err))
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
