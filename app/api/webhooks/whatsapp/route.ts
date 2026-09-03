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
 *
 * Coexistence (owner keeps using the WhatsApp Business app on the same
 * number) additionally delivers `smb_message_echoes` changes on this same
 * endpoint. Every origin decision for both fields is made in
 * lib/whatsapp/coexistence.ts; this route only routes.
 */

import { NextRequest, NextResponse, after } from 'next/server'
import { createHmac } from 'crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { generateCayeAutoReply } from '@/lib/caye-reply'
import { enqueueHoldPing, enqueueBookingCreated } from '@/lib/whatsapp/triggers'
import { applyEscalation } from '@/lib/whatsapp/escalation'
import { extractHoldTargetDate } from '@/lib/whatsapp/urgency'
import { maybeRefreshContactProfile } from '@/lib/contact-profile'
import { syncBookingToCalendar } from '@/lib/calendar-sync'
import type { VoiceProfile } from '@/lib/voice-profile'
import { alertFounderOfDeliveryFailure } from '@/lib/whatsapp/founder-alert'
import { OPERATOR_LOGGABLE_KINDS } from '@/app/api/caye/outbound-worker/route'
import { mediaPlaceholder } from '@/lib/operator-text-guard'
import { resolveOrCreateContact } from '@/lib/contacts/resolve-contact'
import {
  parseWhatsAppWebhook,
  classifyInboundOrigin,
  classifyEchoOrigin,
  isAutoReplyEligible,
  normalizeEcho,
  metaTimestampToISO,
  WHATSAPP_ECHO_FIELD,
  type ParsedWhatsAppChange,
  type RawWaStatus,
} from '@/lib/whatsapp/coexistence'
import {
  echoMatchesRecordedCayeSend,
  ingestObservedBusinessMessage,
  recordUnattributedBusinessMessage,
} from '@/lib/whatsapp/coexistence-ingest'

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

/**
 * Fans one webhook delivery out to the right handler per change.
 *
 * Exported for tests only — POST is still the sole production entry point.
 * Same precedent as app/api/caye/outbound-worker/route.ts, whose helpers are
 * imported by their own tests and by this file.
 *
 * Reads every `entry[].changes[]`, not just the first: a coexistence echo
 * arrives as its own change with `field: 'smb_message_echoes'`, and Meta may
 * batch it in the same delivery as an ordinary `messages` change. The old
 * `entry[0].changes[0]` read would have silently dropped one of them.
 */
export async function processInboundWhatsApp(payload: Record<string, unknown>): Promise<void> {
  const changes = parseWhatsAppWebhook(payload)

  if (changes.length === 0) {
    console.warn('[whatsapp webhook] No changes in payload — skipping')
    return
  }

  for (const change of changes) {
    if (!change.supported) {
      // Never throw on an unrecognized shape: a 500 here makes Meta retry a
      // payload we will never understand. Deferred coexistence fields
      // (history, smb_app_state_sync) are named separately from genuinely
      // unknown ones so the log distinguishes "not built yet" from "new".
      console.log(
        `[whatsapp webhook] Skipping change field="${change.field}" reason=${change.unsupportedReason}`
      )
      continue
    }

    // Delivery-status callbacks (sent/delivered/read/failed) arrive on this
    // same webhook, keyed by the message ID we stored as wa_message_id when
    // we sent it — see lib/whatsapp/founder-alert.ts for why this matters.
    // These used to be silently dropped ("Meta also sends delivery receipts
    // with no messages array — ignore silently"), which is exactly how a
    // failed send could sit unnoticed.
    if (change.statuses.length > 0) {
      await processDeliveryStatuses(change.statuses)
    }

    if (change.field === WHATSAPP_ECHO_FIELD) {
      await processBusinessAppEchoes(change)
      continue
    }

    // Meta sends delivery-receipt-only payloads with no messages array —
    // nothing else to do for those once processDeliveryStatuses has run.
    if (change.messages.length === 0) continue

    await processCustomerMessages(change)
  }
}

/** Resolves the workspace's WhatsApp account for a Meta phone_number_id. */
async function loadWhatsAppAccount(
  supabase: ReturnType<typeof createServiceClient>,
  phoneNumberId: string
) {
  const { data: account } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('channel_type', 'whatsapp')
    .eq('channel_account_id', phoneNumberId)
    .eq('is_active', true)
    .maybeSingle()
  if (!account) {
    console.warn(`[whatsapp webhook] No connected account for phone_number_id: ${phoneNumberId}`)
    return null
  }
  return account
}

/**
 * Coexistence: messages the owner sent from the WhatsApp Business app or a
 * linked device.
 *
 * There is no branch below that can reach generateCayeAutoReply or any send
 * helper. That is deliberate and structural — see
 * lib/whatsapp/coexistence-ingest.ts.
 */
async function processBusinessAppEchoes(change: ParsedWhatsAppChange): Promise<void> {
  const metadata = change.metadata
  if (!metadata || change.echoes.length === 0) return

  const supabase = createServiceClient()
  const account = await loadWhatsAppAccount(supabase, metadata.phoneNumberId)
  if (!account) return

  for (const rawEcho of change.echoes) {
    const observed = normalizeEcho(rawEcho, metadata)
    if (!observed) {
      console.warn('[whatsapp webhook] Unusable echo (missing id/to/timestamp/type) — skipping')
      continue
    }

    // Meta does not document whether a Cloud API send also produces an echo.
    // Reconciling against what Caye already recorded answers that per-message
    // instead of assuming it — an echo we can prove Caye sent is never
    // re-attributed to the owner, and never persisted twice.
    const matched = await echoMatchesRecordedCayeSend(supabase, observed.providerMessageId)
    const origin = classifyEchoOrigin(matched)

    const result = await ingestObservedBusinessMessage(
      supabase,
      { id: account.id, workspaceId: account.user_id },
      observed,
      origin
    )
    console.log(
      `[whatsapp webhook] Coexistence echo ${observed.providerMessageId} origin=${origin} outcome=${result.outcome}`
    )
  }
}

async function processCustomerMessages(change: ParsedWhatsAppChange): Promise<void> {
  const metadata = change.metadata
  if (!metadata) return
  const phone_number_id = metadata.phoneNumberId
  const { contacts, messages } = change

  const supabase = createServiceClient()

  const account = await loadWhatsAppAccount(supabase, phone_number_id)
  if (!account) return

  const workspaceId: string = account.user_id

  // The business's own number, used to tell an ordinary customer message
  // apart from one whose authorship we cannot establish.
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
    // Read rather than cast. The normalization boundary hands back what Meta
    // actually sent, with every field optional; a message missing its id,
    // sender, type or timestamp is unusable and is skipped rather than
    // becoming a row with `undefined` in a key column.
    const messageId = typeof message.id === 'string' ? message.id : ''
    const from = typeof message.from === 'string' ? message.from : ''
    const messageType = typeof message.type === 'string' ? message.type : ''
    const sentAt = metaTimestampToISO(message.timestamp)
    if (!messageId || !from || !messageType || !sentAt) {
      console.warn('[whatsapp webhook] Unusable message (missing id/from/type/timestamp) — skipping')
      continue
    }
    const isTextMessage = messageType === 'text'
    const body = typeof message.text?.body === 'string' ? message.text.body : ''

    // Origin replaces the old self-loop guard. Same outcome for the loop it
    // protected against — a message from the business's own number still
    // never reaches the reply path — but it is now an explicit
    // classification rather than a silent `continue`, and the message is
    // recorded as observed-with-unknown-authorship instead of vanishing.
    const origin = classifyInboundOrigin(from, businessPhone)
    if (!isAutoReplyEligible(origin)) {
      await recordUnattributedBusinessMessage(supabase, {
        workspaceId,
        providerMessageId: messageId,
        observedAt: sentAt,
        messageType,
        phoneNumberId: phone_number_id,
        preview: isTextMessage ? body : mediaPlaceholder(messageType),
      })
      console.log(`[whatsapp webhook] Business-origin message ${messageId} origin=${origin} — observed, no reply`)
      continue
    }

    // Resolve customer name from contacts array
    const contact = contacts?.find(c => c.wa_id === from)
    const customerName = contact?.profile?.name ?? from

    // Resolve/create the canonical Person for this WhatsApp sender — the
    // shared identity path every inbound channel goes through (see
    // lib/contacts/resolve-contact.ts).
    const contactRow = await resolveOrCreateContact(supabase, {
      workspaceId,
      channelType: 'whatsapp',
      channelId: from,
      name: customerName,
      at: sentAt,
    })

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
          last_message_preview: isTextMessage ? body.slice(0, 100) : mediaPlaceholder(messageType),
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
        content: isTextMessage ? body : mediaPlaceholder(messageType),
        message_type: isTextMessage ? 'text' : messageType,
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
      body,
    })

    if (decision.action === 'hold') {
      // Hold the conversation and leave an internal note for the owner
      await supabase
        .from('unified_conversations')
        .update({
          human_agent_enabled: true,
          human_agent_reason: decision.reason,
          target_date: extractHoldTargetDate(decision.reason, body),
        })
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
      // Awaited (was fire-and-forget) — an unawaited promise here can get
      // torn down by the serverless runtime the instant this handler
      // returns, silently dropping the operator ping. Internally still
      // no-ops if the workspace flag is off or the operator number isn't
      // verified.
      await enqueueHoldPing({
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
    let waMessageId: string | null = null
    try {
      waMessageId = await sendWhatsAppMessage(from, decision.content, phone_number_id, account.access_token)
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
      metadata: {
        is_automated: true,
        generated_by: 'caye',
        phone_number_id,
        // Meta's id for this exact send. channel_message_id above stays the
        // synthetic `caye_wa_…` value other code already keys on; this is
        // additive, and is what a coexistence echo reconciles against.
        ...(waMessageId ? { wa_message_id: waMessageId } : {}),
        ...(decision.autonomyAudit ? { autonomy: decision.autonomyAudit } : {}),
      },
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
      enqueueBookingCreated({
        workspaceId,
        conversationId: conversation.id,
        bookingId: decision.bookingId,
      }).catch(err => console.error('[whatsapp webhook] enqueueBookingCreated failed:', err))
      console.log(
        `[whatsapp webhook] Caye created booking ${decision.bookingId} for workspace ${workspaceId}`
      )
    }

    console.log(`[whatsapp webhook] Auto-reply sent to ${from} for workspace ${workspaceId}`)
  }
}

/**
 * Consume Meta's delivery-status callbacks into caye_outbound_queue —
 * columns wa_delivery_status/_at/_error already existed but nothing wrote
 * to them before this. A row we don't recognize (no matching wa_message_id
 * — e.g. a manual send outside the queue) is ignored; not every WhatsApp
 * send on the platform goes through the queue.
 */
async function processDeliveryStatuses(statuses: RawWaStatus[]): Promise<void> {
  const supabase = createServiceClient()

  for (const s of statuses) {
    // Provider fields are optional at the normalization boundary. Without an
    // id there is nothing to match a queue row on; without a status there is
    // nothing to record. A missing/garbled timestamp costs only the time
    // column — the status itself is still worth writing, and inventing now()
    // for it would misreport when delivery happened.
    if (!s.id || !s.status) {
      console.warn('[whatsapp webhook] Delivery status missing id/status — skipping')
      continue
    }
    const errorMsg = s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? null
    const statusAt = metaTimestampToISO(s.timestamp)

    const { data: updated, error } = await supabase
      .from('caye_outbound_queue')
      .update({
        wa_delivery_status: s.status,
        wa_delivery_status_at: statusAt,
        wa_delivery_error: errorMsg,
        updated_at: new Date().toISOString(),
      })
      .eq('wa_message_id', s.id)
      .select('id, workspace_id, kind')
      .maybeSingle()

    if (error) {
      console.error('[whatsapp webhook] delivery-status update failed:', error)
      continue
    }
    if (!updated) continue // no queue row for this message id — not ours to track

    if (s.status === 'failed' && OPERATOR_LOGGABLE_KINDS.has(updated.kind)) {
      await alertFounderOfDeliveryFailure({
        workspaceId: updated.workspace_id,
        kind: updated.kind,
        detail: errorMsg,
        stage: 'delivery',
      }).catch(err => console.error('[whatsapp webhook] delivery-failure founder alert failed:', err))
    }
  }
}
