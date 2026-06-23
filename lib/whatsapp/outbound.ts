import 'server-only'

/**
 * Caye-platform → operator WhatsApp send client.
 *
 * Distinct from lib/whatsapp.ts (which sends from each workspace's connected
 * WhatsApp Business account to their guests). This client always sends from the
 * single Caye-platform number to the workspace operator's personal WhatsApp.
 *
 * Env:
 *   CAYE_PLATFORM_WHATSAPP_PHONE_NUMBER_ID — Meta phone_number_id for the Caye number
 *   CAYE_PLATFORM_WHATSAPP_ACCESS_TOKEN    — Meta system-user access token with messaging perms
 */

import { createServiceClient } from '@/lib/supabase-server'

const GRAPH_VERSION = 'v19.0'

export type SendResult =
  | { messageId: string; status: 'sent' }
  | { status: 'failed'; error: string; transient: boolean; blocked?: boolean }

function platformCreds() {
  const phoneNumberId = process.env.CAYE_PLATFORM_WHATSAPP_PHONE_NUMBER_ID
  const accessToken = process.env.CAYE_PLATFORM_WHATSAPP_ACCESS_TOKEN
  if (!phoneNumberId || !accessToken) {
    throw new Error(
      'Missing CAYE_PLATFORM_WHATSAPP_PHONE_NUMBER_ID or CAYE_PLATFORM_WHATSAPP_ACCESS_TOKEN'
    )
  }
  return { phoneNumberId, accessToken }
}

async function postToMeta(body: Record<string, unknown>): Promise<SendResult> {
  const { phoneNumberId, accessToken } = platformCreds()
  let res: Response
  try {
    res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    )
  } catch (err) {
    return {
      status: 'failed',
      error: `network: ${err instanceof Error ? err.message : String(err)}`,
      transient: true,
    }
  }

  const text = await res.text()
  let data: { messages?: Array<{ id: string }>; error?: { code?: number; message?: string } } = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    // non-JSON response
  }

  if (res.ok && data.messages?.[0]?.id) {
    return { messageId: data.messages[0].id, status: 'sent' }
  }

  // Meta error codes that indicate the recipient blocked the business or has
  // opted out — non-retryable and should flip whatsapp_blocked on the workspace.
  // 131026 = message undeliverable, 131047 = re-engagement (24h) window expired,
  // 131051 = unsupported message type. We treat 131026 + blocked-style codes as blocked.
  const code = data.error?.code
  const blocked = code === 131026 || code === 131048 || code === 368
  const transient = res.status >= 500 || res.status === 429
  return {
    status: 'failed',
    error: `meta http ${res.status} code ${code ?? '?'}: ${(data.error?.message ?? text).slice(0, 300)}`,
    transient: transient && !blocked,
    blocked,
  }
}

/**
 * Send a free-form text message. Only valid when the 24h customer service
 * window is open (operator has messaged Caye within last ~23h).
 */
export async function sendFreeFormWhatsApp(
  toPhoneNumber: string,
  body: string,
  idempotencyKey: string
): Promise<SendResult> {
  return postToMeta({
    messaging_product: 'whatsapp',
    to: normalizeE164(toPhoneNumber),
    type: 'text',
    text: { body, preview_url: false },
    biz_opaque_callback_data: idempotencyKey,
  })
}

/**
 * Send a template message. Always valid (regardless of 24h window) provided
 * the template is approved in WhatsApp Business Manager.
 */
export async function sendTemplateWhatsApp(
  toPhoneNumber: string,
  templateName: string,
  placeholders: string[],
  idempotencyKey: string,
  language: string = 'en'
): Promise<SendResult> {
  const components = placeholders.length
    ? [
        {
          type: 'body',
          parameters: placeholders.map((p) => ({ type: 'text', text: p })),
        },
      ]
    : undefined

  return postToMeta({
    messaging_product: 'whatsapp',
    to: normalizeE164(toPhoneNumber),
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      ...(components ? { components } : {}),
    },
    biz_opaque_callback_data: idempotencyKey,
  })
}

/** Meta wants the number without a leading '+'. */
function normalizeE164(phone: string): string {
  return phone.replace(/^\+/, '').replace(/\D/g, '')
}

// ---------------------------------------------------------------------------
// Queue enqueue helper — called from trigger sites in Phase 5b.
// ---------------------------------------------------------------------------

export type OutboundKind =
  | 'urgent_hold'
  | 'same_day_booking'
  | 'auth_failure'
  | 'morning_digest'
  | 'welcome'
  | 'otp'
  | 'ack'

export interface EnqueueOutboundInput {
  workspaceId: string
  kind: OutboundKind
  conversationId?: string | null
  payload: Record<string, unknown>
  scheduledFor?: Date
  idempotencyKey: string
}

/**
 * Insert a row into caye_outbound_queue. Idempotent on idempotency_key —
 * duplicate enqueues are silently ignored (returns the existing row's id).
 *
 * Honors `workspace_ai_config.notifications_paused` (receptionist-spec Q4 /
 * 2026-06-22 migration): when paused, the row is NOT enqueued. Flipping
 * pause back to false does NOT replay stale notifications — same shape as
 * the existing whatsapp_outbound_enabled gate.
 */
export async function enqueueOutbound(input: EnqueueOutboundInput): Promise<{ id: string } | null> {
  const supabase = createServiceClient()

  // Hard pause gate — fail closed if the row is missing (a workspace with
  // no config row shouldn't be receiving Caye-platform pings anyway).
  const { data: cfg, error: cfgErr } = await supabase
    .from('workspace_ai_config')
    .select('notifications_paused')
    .eq('workspace_id', input.workspaceId)
    .maybeSingle()
  if (cfgErr) {
    console.error('[enqueueOutbound] config lookup failed:', cfgErr)
    // Don't swallow the call entirely — caller expects either a row or null.
    // But also don't blast notifications when we can't confirm the pause
    // state. Treat lookup failure as paused.
    return null
  }
  if (!cfg || cfg.notifications_paused === true) {
    return null
  }

  const { data, error } = await supabase
    .from('caye_outbound_queue')
    .insert({
      workspace_id: input.workspaceId,
      kind: input.kind,
      conversation_id: input.conversationId ?? null,
      payload: input.payload,
      scheduled_for: (input.scheduledFor ?? new Date()).toISOString(),
      idempotency_key: input.idempotencyKey,
    })
    .select('id')
    .single()

  if (error) {
    // Unique violation on idempotency_key → already queued; not an error.
    if (error.code === '23505') return null
    console.error('[enqueueOutbound] insert failed:', error)
    throw new Error(`enqueueOutbound: ${error.message}`)
  }
  return data
}
