/**
 * POST /api/webhooks/whatsapp-operator
 *
 * Inbound webhook for the Caye-platform WhatsApp number (operator-facing).
 * Distinct from /api/webhooks/whatsapp (which handles guest messages on each
 * workspace's connected WhatsApp Business number).
 *
 * Flow:
 *   1. Verify Meta signature (META_APP_SECRET shared across both endpoints).
 *   2. For each inbound message:
 *      - Look up workspace by operator_whatsapp_number = from.
 *      - Stamp last_whatsapp_inbound_at (opens the 24h free-form window).
 *      - Persist to caye_operator_messages (inbound) for audit.
 *      - Classify intent against the current pending held items.
 *      - Dispatch action handler; queue any ack body back via enqueueOutbound.
 *
 * Configure Meta to call this URL for the Caye-platform phone number's
 * webhook subscription. The verify token matches META_WEBHOOK_VERIFY_TOKEN.
 */

import { NextRequest, NextResponse, after } from 'next/server'
import { createHmac } from 'crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { classifyOperatorIntent } from '@/lib/whatsapp/intent'
import { getPendingHeldItems } from '@/lib/whatsapp/pending'
import { dispatchOperatorIntent } from '@/lib/whatsapp/actions'
import { enqueueOutbound } from '@/lib/whatsapp/outbound'

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

// ─── POST — inbound operator messages ────────────────────────────────────────

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
      console.warn('[whatsapp-operator] Signature mismatch — rejecting')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(
    processInbound(payload).catch((err) =>
      console.error('[whatsapp-operator] processing error:', err)
    )
  )

  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

// ─── Background processor ────────────────────────────────────────────────────

interface WaInboundMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  context?: { id: string; from?: string }
}

interface WaValue {
  metadata?: { phone_number_id?: string }
  messages?: WaInboundMessage[]
}

async function processInbound(payload: Record<string, unknown>): Promise<void> {
  const entry = (payload.entry as Record<string, unknown>[] | undefined)?.[0]
  const change = (entry?.changes as Record<string, unknown>[] | undefined)?.[0]
  const value = change?.value as WaValue | undefined
  if (!value?.messages?.length) return

  const expectedPhoneNumberId = process.env.CAYE_PLATFORM_WHATSAPP_PHONE_NUMBER_ID
  if (expectedPhoneNumberId && value.metadata?.phone_number_id !== expectedPhoneNumberId) {
    // Not the Caye-platform number — this webhook was misrouted.
    return
  }

  const supabase = createServiceClient()

  for (const message of value.messages) {
    await handleOneInbound(supabase, message)
  }
}

async function handleOneInbound(
  supabase: ReturnType<typeof createServiceClient>,
  message: WaInboundMessage
): Promise<void> {
  const fromRaw = message.from
  const normalized = normalizeE164(fromRaw)
  if (!normalized) return

  // Look up the workspace by operator number. Try both with and without leading '+'.
  const { data: cfg } = await supabase
    .from('workspace_ai_config')
    .select('workspace_id, whatsapp_outbound_enabled')
    .or(`operator_whatsapp_number.eq.${normalized},operator_whatsapp_number.eq.+${normalized}`)
    .maybeSingle()

  if (!cfg) {
    console.warn(`[whatsapp-operator] no workspace for from=${fromRaw}`)
    return
  }

  const workspaceId: string = cfg.workspace_id
  const now = new Date().toISOString()

  // Open the 24h free-form window regardless of message type.
  await supabase
    .from('workspace_ai_config')
    .update({ last_whatsapp_inbound_at: now })
    .eq('workspace_id', workspaceId)

  if (message.type !== 'text' || !message.text?.body) {
    // Non-text — just log and bail. We don't classify media in v1.
    await supabase.from('caye_operator_messages').insert({
      workspace_id: workspaceId,
      direction: 'inbound',
      wa_message_id: message.id,
      body: `[${message.type}]`,
      intent: null,
    })
    return
  }

  const body = message.text.body.trim()

  // Classify against current pending state.
  const pending = await getPendingHeldItems(workspaceId)

  let lastOutboundBody: string | null = null
  if (message.context?.id) {
    // Operator used reply-to. The quoted message id is Meta's — we don't store it
    // directly, so fetch our most recent outbound to this operator for context.
    const { data: lastRow } = await supabase
      .from('caye_operator_messages')
      .select('body')
      .eq('workspace_id', workspaceId)
      .eq('direction', 'outbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    lastOutboundBody = lastRow?.body ?? null
  }

  const intent = await classifyOperatorIntent({
    operatorText: body,
    pending,
    lastCayeOutboundBody: lastOutboundBody,
    quotedMessage: null,
  })

  // Persist inbound + classified intent (best-effort dedup on wa_message_id).
  await supabase.from('caye_operator_messages').insert({
    workspace_id: workspaceId,
    direction: 'inbound',
    wa_message_id: message.id,
    body,
    intent,
  })

  // If the workspace flag is off we don't act on intents — but we still logged
  // and stamped the window. This means flipping the flag back on doesn't replay
  // stale instructions.
  if (!cfg.whatsapp_outbound_enabled) {
    console.log(`[whatsapp-operator] flag off for ${workspaceId} — skipping action`)
    return
  }

  const result = await dispatchOperatorIntent({ workspaceId }, intent, pending)

  if (result.ackBody && result.ackBody.trim()) {
    await enqueueOutbound({
      workspaceId,
      kind: 'ack',
      payload: { body: result.ackBody },
      idempotencyKey: `ack-${message.id}`,
    })
    // Also log the outbound ack we just queued (the worker logs send status separately).
    await supabase.from('caye_operator_messages').insert({
      workspace_id: workspaceId,
      direction: 'outbound',
      wa_message_id: null,
      body: result.ackBody,
      intent: null,
    })
  }
}

function normalizeE164(phone: string): string {
  return phone.replace(/^\+/, '').replace(/\D/g, '')
}
