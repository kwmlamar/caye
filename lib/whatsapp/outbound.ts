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

export interface OperatorMessageDeliveryFields {
  wa_message_id: string | null
  wa_delivery_status: 'sent' | 'failed'
  wa_delivery_error: string | null
}

/**
 * Maps a dispatch-time SendResult onto caye_operator_messages' delivery
 * columns, for every call site that logs a message it just sent over
 * WhatsApp. 'sent'/'failed' here is our own dispatch outcome — Meta's async
 * status webhook (handleDeliveryStatus) later overwrites wa_delivery_status
 * to 'delivered'/'read'/'failed' by matching wa_message_id, same as it
 * already does for caye_outbound_queue.
 */
export function deliveryFieldsFromResult(result: SendResult): OperatorMessageDeliveryFields {
  if (result.status === 'sent') {
    return { wa_message_id: result.messageId, wa_delivery_status: 'sent', wa_delivery_error: null }
  }
  return { wa_message_id: null, wa_delivery_status: 'failed', wa_delivery_error: result.error }
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
  | 'booking_created'
  | 'auth_failure'
  | 'morning_digest'
  | 'welcome'
  | 'otp'
  | 'ack'
  | 'escalation'
  | 'escalation_followup'
  // The scan crons' operator-facing findings (opportunity-scan,
  // business-insights). Carries the real finding/insight text in
  // payload.freeFormBody either way — see freeFormBodyForKind and
  // templateForKind in app/api/caye/outbound-worker/route.ts. Used to be a
  // window-closed-only, content-free "come look" ping; as of 2026-08-13
  // both crons enqueue unconditionally and dispatch() picks free-form vs
  // template per-recipient at actual send time, same as 'escalation'.
  | 'opportunity_scan'
  | 'business_insights'
  // Operator-set reminder (schedule_reminder). Free-form only — there is no
  // approved Meta template for it, so a closed 24h window means it can't go
  // out over WhatsApp. It's in OPERATOR_LOGGABLE_KINDS so it still lands in
  // Caye Direct in that case rather than disappearing.
  | 'operator_reminder'
  // A staged action the operator was shown, then never executed and never
  // cancelled — it just expired (dropped-confirmation-sweep). Same free-form
  // constraint as operator_reminder: no approved template, so a closed window
  // means it lands in Caye Direct instead. In practice the operator was
  // mid-conversation minutes earlier, so the window is open.
  | 'dropped_confirmation'
  // Caye's one-time proactive ping to the operator when a customer hits a
  // payment request and Charge Anywhere isn't connected yet — see
  // supabase/migrations/20260813d_add_payment_setup_needed_outbound_kind.sql
  // and workspace_payment_integrations (20260813c). Type-level sync only:
  // no call site enqueues this yet (the request_payment_setup function the
  // migration references, lib/payments/payment-request.ts, doesn't exist),
  // so this value is currently unreachable in practice — but the DB
  // constraint already allows it, and leaving OutboundKind out of sync with
  // the constraint is exactly the drift class db-enum-literals.test.ts and
  // lib/outbound-kind-migration-sync.test.ts exist to catch. Do not add a
  // freeFormBodyForKind/templateForKind case for this until the real
  // enqueue call site is built — an unreachable case is untestable dead
  // code before then.
  | 'payment_setup_needed'

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
    // Fire-and-forget, deliberately not awaited — an alert that can fail must
    // never be able to swallow or delay the throw below, which is the part
    // every caller actually depends on for its own error handling.
    alertFounderOfEnqueueFailure({ workspaceId: input.workspaceId, kind: input.kind, detail: error.message })
    throw new Error(`enqueueOutbound: ${error.message}`)
  }
  return data
}

/**
 * Tell the founder when a row can't even be QUEUED — distinct from, and
 * upstream of, alertFounderOfDeliveryFailure in founder-alert.ts (which
 * covers a queued row that later fails to SEND).
 *
 * WHY THIS EXISTS (2026-08-12)
 * 'booking_created' has never once enqueued successfully since the feature
 * existed (2026-05-28) — the DB CHECK constraint said 'same_day_booking',
 * the code said 'booking_created', and every insert was rejected. Every one
 * of the 7 call sites does `enqueueBookingCreated(...).catch(err =>
 * console.error(...))` — a deliberate, correct choice (a notification
 * failure must never block the booking itself succeeding), but the
 * consequence was that the only trace of a permanently-broken kind was a
 * console.error nobody was watching. It took over two months to surface,
 * and only because an unrelated task happened to hit the same constraint.
 *
 * This does not fix that class of bug — the migration/constraint check
 * does (see lib/db-enum-literals.test.ts and
 * scripts/verify-outbound-kind-constraint.ts). This fixes how long the
 * NEXT one like it stays invisible.
 *
 * Deliberately NOT routed through classifyDeliveryError/extractErrorCode —
 * those parse Meta Cloud API error codes, and a Postgres constraint
 * violation is not one. Forcing an insert failure through Meta-specific
 * account_fatal branching risks misclassifying it and emailing the founder
 * "WhatsApp is down account-wide" for a bug that has nothing to do with
 * WhatsApp being down. This stays deliberately simpler: one WhatsApp ping
 * to the founder, deduped hourly per (workspace, kind), same table and same
 * bucketing scheme founder-alert.ts already uses so the two failure classes
 * don't fight over the same dedup keys.
 */
async function alertFounderOfEnqueueFailure(args: {
  workspaceId: string
  kind: string
  detail: string
}): Promise<void> {
  try {
    const supabase = createServiceClient()
    const bucket = Math.floor(Date.now() / (60 * 60 * 1000))
    const alertKey = `wa-enqueue-fail-alert-${args.workspaceId}-${args.kind}-${bucket}`

    const { error: dedupErr } = await supabase
      .from('caye_founder_alert_log')
      .insert({ alert_key: alertKey })
    if (dedupErr) {
      if (dedupErr.code === '23505') return // already alerted this bucket
      console.error('[enqueueOutbound] alert dedup check failed:', dedupErr)
      return
    }

    const { data: customer } = await supabase
      .from('customers')
      .select('business_name')
      .eq('id', args.workspaceId)
      .maybeSingle()
    const business = (customer?.business_name as string | null) ?? args.workspaceId

    const { data: setting } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'founder_phone')
      .maybeSingle()
    const founderPhone = setting?.value as string | undefined
    if (!founderPhone) {
      console.error(
        `[enqueueOutbound] ${args.kind} could not be queued for ${business} but no founder_phone configured:`,
        args.detail
      )
      return
    }

    const messageBody =
      `⚠️ ${business}: couldn't queue a ${args.kind} notification — ${args.detail.slice(0, 200)}. ` +
      `Likely a DB constraint the code has outgrown; check caye_outbound_queue_kind_check.`
    const result = await sendFreeFormWhatsApp(founderPhone, messageBody, alertKey)
    if (result.status === 'failed') {
      console.error('[enqueueOutbound] alert send failed:', result.error)
    }
  } catch (err) {
    console.error('[enqueueOutbound] alertFounderOfEnqueueFailure failed:', err)
  }
}
