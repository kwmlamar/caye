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
 *      - Dispatch action handler; send any ack body back synchronously via sendFreeFormWhatsApp.
 *
 * Configure Meta to call this URL for the Caye-platform phone number's
 * webhook subscription. The verify token matches META_WEBHOOK_VERIFY_TOKEN.
 */

import { NextRequest, NextResponse, after } from 'next/server'
import { createHmac } from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import {
  classifyOperatorIntent,
  type OperatorIntent,
  type SingleOperatorIntent,
} from '@/lib/whatsapp/intent'
import { resolveTurnOwner } from '@/lib/whatsapp/turn-ownership'
import {
  resolveActiveOwnerTask,
  markOwnerTaskHandled,
  ownerHandledAcknowledgement,
  isOwnerCompletionStatement,
} from '@/lib/whatsapp/active-owner-task'
import { withSlowTurnHeartbeat } from '@/lib/whatsapp/slow-turn-heartbeat'
import { corroborateItemRef } from '@/lib/whatsapp/item-ref-guard'
import { namesUnresolvedTarget } from '@/lib/whatsapp/item-ref-resolution'
import { getPendingHeldItems } from '@/lib/whatsapp/pending'
import { resolveAcknowledgedAttentionItems, acknowledgeAttentionItems } from '@/lib/whatsapp/attention-acknowledgement'
import { dispatchOperatorIntent } from '@/lib/whatsapp/actions'
import { sendFreeFormWhatsApp, deliveryFieldsFromResult, type SendResult } from '@/lib/whatsapp/outbound'
import { downloadWhatsAppMedia, isSupportedImageMimeType } from '@/lib/whatsapp/media'
import { decideImageBurst } from '@/lib/whatsapp/image-burst'
import { generateCayeAutoReply } from '@/lib/caye-reply'
import { alertFounderOfDeliveryFailure } from '@/lib/whatsapp/founder-alert'
import { emailFallbackForFailedPing } from '@/lib/whatsapp/email-fallback'
import { OPERATOR_LOGGABLE_KINDS, EMAIL_FALLBACK_KINDS, UNREACHABLE_STREAK_THRESHOLD } from '@/app/api/caye/outbound-worker/route'
import { cayeAgent } from '@/lib/caye-agent'
import { persistAgentTurns } from '@/lib/caye-operator-messages'
import { linkInsertedMessagesToThreads } from '@/lib/caye-direct-threads'
import {
  extractSignupCode,
  tryAutoProvisionOwner,
  tryColdStartWorkspace,
  firstDiscoveryMessage,
  handleDiscoveryAnswer,
  normalizeE164,
} from '@/lib/onboarding-whatsapp'
import { shouldSyncOnboardingOperatorName } from '@/lib/onboarding-operator-name'
import { FIRST_DISCOVERY_QUESTION } from '@/lib/onboarding'
import { mediaPlaceholder } from '@/lib/operator-text-guard'
import { fetchBusinessFacts, formatBusinessFactsBlock } from '@/lib/business-facts'
import { routeOperatorLearningCorrection } from '@/lib/operator-learning-router'
import {
  getActiveDemoSession,
  startDemoSession,
  endDemoSession,
  isDemoEntryKeyword,
  isDemoExitKeyword,
  loadDemoHistory,
  advanceDemoSession,
  generateDemoReply,
  DEMO_INTRO_MESSAGE,
  DEMO_EXIT_MESSAGE,
} from '@/lib/caye-demo'

// Held-item action intents stay on the legacy classifier+dispatch path
// for now — those reply flows (send / skip / edit / handled / mute /
// unmute / multi) are well-tested and will be migrated to back-office
// agent TOOLS in slices 4-6 of epic #35.
//
// Anything else (`query` and `unclear`) routes through the new tool-use
// agent. This is the slice 1 cutover: every general conversational
// operator message now goes through back-office Caye.
const LEGACY_DISPATCH_KINDS = new Set([
  'send',
  'skip',
  'edit',
  'handled',
  'mute',
  'unmute',
  'multi',
])

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
  /** Present when type === 'button' — a tap on a template Quick Reply
   *  button (2026-07-05, caye_driver_consent's "OK" button). Meta echoes
   *  the button's label back as .text. */
  button?: { text?: string; payload?: string }
  /** Present when type === 'image' — a photo/screenshot sent to Caye Direct. */
  image?: { id: string; mime_type: string; sha256?: string; caption?: string }
  context?: { id: string; from?: string }
}

/** Meta delivery-status callback — arrives on this same webhook, keyed by
 *  the message id returned at send time (lib/whatsapp/outbound.ts). */
interface WaStatusUpdate {
  id: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  timestamp?: string
  errors?: Array<{ code?: number; title?: string; message?: string }>
}

interface WaValue {
  metadata?: { phone_number_id?: string }
  messages?: WaInboundMessage[]
  statuses?: WaStatusUpdate[]
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>
}

async function processInbound(payload: Record<string, unknown>): Promise<void> {
  const entry = (payload.entry as Record<string, unknown>[] | undefined)?.[0]
  const change = (entry?.changes as Record<string, unknown>[] | undefined)?.[0]
  const value = change?.value as WaValue | undefined
  if (!value) return

  const expectedPhoneNumberId = process.env.CAYE_PLATFORM_WHATSAPP_PHONE_NUMBER_ID
  if (expectedPhoneNumberId && value.metadata?.phone_number_id !== expectedPhoneNumberId) {
    // Not the Caye-platform number — this webhook was misrouted.
    return
  }

  const supabase = createServiceClient()

  // entry[].id is the WhatsApp Business Account id, and the phone_number_id
  // guard above already proved this event belongs to the Caye platform
  // number — so this is the platform WABA. Captured because the template
  // sync (lib/whatsapp/template-sync.ts) needs it to read template
  // definitions back from Meta, and having it self-populate beats a manual
  // env var that nobody remembers to set until something breaks.
  await captureWabaId(supabase, entry?.id as string | undefined)

  if (value.statuses?.length) {
    for (const s of value.statuses) {
      await handleDeliveryStatus(supabase, s)
    }
  }

  if (!value.messages?.length) return

  for (const message of value.messages) {
    const contact = value.contacts?.find((candidate) => normalizeE164(candidate.wa_id ?? '') === normalizeE164(message.from))
    await handleOneInbound(supabase, message, contact?.profile?.name)
  }
}

/**
 * Best-effort, write-once-then-idle: only writes when the stored value is
 * absent or has changed, so the common case is a single cheap read per
 * webhook. Never throws — losing this must never cost us an inbound message.
 */
async function captureWabaId(
  supabase: ReturnType<typeof createServiceClient>,
  wabaId: string | undefined
): Promise<void> {
  if (!wabaId) return
  try {
    const { data } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'whatsapp_business_account_id')
      .maybeSingle()
    if (data?.value === wabaId) return

    await supabase
      .from('platform_settings')
      .upsert({ key: 'whatsapp_business_account_id', value: wabaId }, { onConflict: 'key' })
  } catch (err) {
    console.error('[whatsapp-operator] WABA id capture failed:', err)
  }
}

/**
 * Only matches rows sent through caye_outbound_queue (proactive pings —
 * escalations, urgent holds, digests) since those are the only sends that
 * store wa_message_id. Synchronous replies (acks, back-office chat) aren't
 * queued, so their statuses have nothing to match and are silently no-ops
 * — acceptable: those are reactive responses to a message the operator
 * just sent, not the "Caye pinged you unprompted" case this exists for.
 */
/**
 * 2026-07-27: this handler wrote the status columns and stopped — the
 * customer-facing webhook (app/api/webhooks/whatsapp/route.ts) alerts the
 * founder on delivery failure, this one never did. Operator pings (the
 * "Caye pinged you unprompted" pings this function exists to confirm) go
 * out over the platform number and land HERE, not on the customer webhook
 * — so that asymmetry meant the exact sends most worth knowing about
 * failing were the ones nobody heard about. Confirmed live: 93 operator
 * pings over 14 days, zero confirmed deliveries, zero founder alerts.
 * See briefs/whatsapp-delivery-reliability.md.
 */
async function handleDeliveryStatus(
  supabase: ReturnType<typeof createServiceClient>,
  s: WaStatusUpdate
): Promise<void> {
  const statusAt = s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : new Date().toISOString()
  const errorText = s.errors?.length
    ? s.errors.map((e) => `${e.code ?? '?'}: ${e.title ?? e.message ?? ''}`).join('; ')
    : null

  const { data: updated, error } = await supabase
    .from('caye_outbound_queue')
    .update({
      wa_delivery_status: s.status,
      wa_delivery_status_at: statusAt,
      wa_delivery_error: errorText,
    })
    .eq('wa_message_id', s.id)
    .select('id, workspace_id, kind, payload')
    .maybeSingle()

  if (error) {
    console.error('[whatsapp-operator] delivery-status update failed:', error)
    return
  }

  // Same update, second table: caye_outbound_queue only ever has a row for
  // the subset of sends that went through the proactive-ping queue, but
  // every logged outbound message — queued or synchronous — carries the
  // same real wa_message_id once dispatched (deliveryFieldsFromResult).
  // This is what makes sent → delivered → read progress show up in Caye
  // Direct for ordinary back-office replies, not just proactive pings. A
  // no-op update when no row's wa_message_id matches is fine and cheap.
  const { error: opMsgError } = await supabase
    .from('caye_operator_messages')
    .update({
      wa_delivery_status: s.status,
      wa_delivery_status_at: statusAt,
      wa_delivery_error: errorText,
    })
    .eq('wa_message_id', s.id)
  if (opMsgError) {
    console.error('[whatsapp-operator] operator-message delivery-status update failed:', opMsgError)
  }

  if (!updated || s.status !== 'failed') return

  const workspaceId = updated.workspace_id as string
  const kind = updated.kind as string
  const payload = (updated.payload ?? {}) as Record<string, unknown>

  if (OPERATOR_LOGGABLE_KINDS.has(kind)) {
    await alertFounderOfDeliveryFailure({
      workspaceId,
      kind,
      detail: errorText,
      stage: 'delivery',
    }).catch((err) => console.error('[whatsapp-operator] delivery-failure founder alert failed:', err))
  }

  if (EMAIL_FALLBACK_KINDS.has(kind)) {
    await emailFallbackForFailedPing({
      workspaceId,
      kind: kind as 'urgent_hold' | 'booking_created' | 'auth_failure',
      payload,
    }).catch((err) => console.error('[whatsapp-operator] delivery-failure email fallback failed:', err))
  }

  // Dispatch-time failures already bump this in outbound-worker's
  // handleResult — a send that Meta *accepted* and later failed async
  // never went through that path, so without this the streak sits at 0
  // through a 100%-async-failing channel (confirmed live 2026-07-27: 3/3
  // sends today failed post-accept, streak never moved).
  const { data: config } = await supabase
    .from('workspace_ai_config')
    .select('whatsapp_failure_streak')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const newStreak = ((config?.whatsapp_failure_streak as number | undefined) ?? 0) + 1
  await supabase
    .from('workspace_ai_config')
    .update({
      whatsapp_failure_streak: newStreak,
      whatsapp_unreachable: newStreak >= UNREACHABLE_STREAK_THRESHOLD,
      last_whatsapp_outbound_status: 'failed',
    })
    .eq('workspace_id', workspaceId)
}

async function handleOneInbound(
  supabase: ReturnType<typeof createServiceClient>,
  message: WaInboundMessage,
  whatsappProfileName?: string
): Promise<void> {
  const fromRaw = message.from
  const normalized = normalizeE164(fromRaw)
  if (!normalized) return

  // Allowlist lookup (#48). Maps phone → workspace_id + role.
  // Try both normalized and +-prefixed phone shapes. Founder's number
  // matches multiple rows (one per workspace) — order by created_at desc
  // for the initial fallback, then override with the founder's
  // platform_settings active-workspace pointer (set via switch_workspace
  // tool) so cross-workspace operation is stateful and explicit.
  let allow = (await supabase
    .from('operator_allowlist')
    .select('id, workspace_id, role, name, verified_at, pending_otp_code, pending_otp_expires_at')
    .or(`phone.eq.${normalized},phone.eq.+${normalized}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()).data

  if (!allow) {
    // Sales demo: a founder-pre-registered prospect phone (see
    // demo_prospects table) gets a live front-desk-persona demo instead
    // of falling into real signup/onboarding below. Checked first, so a
    // demo number can never accidentally cold-start a real workspace.
    if (message.type === 'text' && message.text?.body) {
      const handled = await tryHandleDemoProspect(supabase, normalized, message)
      if (handled) return
    }

    // First contact from an unrecognized phone. Could be an OAuth-created
    // workspace's handoff (carries an invisible signup code — see
    // /onboarding) or a genuinely new WhatsApp-first signup (no code at
    // all, texting Caye directly *is* signing up — see tryColdStartWorkspace).
    const bodyText = message.type === 'text' ? message.text?.body ?? '' : ''
    const signupWorkspaceId = extractSignupCode(bodyText)
    const provisioned = signupWorkspaceId
      ? await tryAutoProvisionOwner(supabase, signupWorkspaceId, normalized)
      : await tryColdStartWorkspace(supabase, normalized)

    if (provisioned) {
      allow = {
        id: provisioned.id,
        workspace_id: provisioned.workspace_id,
        role: provisioned.role,
        name: provisioned.name,
        verified_at: provisioned.verified_at,
        pending_otp_code: null,
        pending_otp_expires_at: null,
      }
    }
  }

  if (!allow) {
    // Only reachable if a signup-code handoff was present but invalid/inert
    // (already claimed, already onboarded) — cold-start above always
    // succeeds unless the DB insert itself fails. Reply rather than drop
    // silently; this is the sender's first inbound message, which opens
    // the 24h customer-service window regardless of enrollment.
    console.warn(`[whatsapp-operator] no allowlist entry for from=${fromRaw}`)
    const sendResult = await sendFreeFormWhatsApp(
      `+${normalized}`,
      "Hey, I'm Caye — I couldn't find your account. If you just signed up on the web, head back to that page and tap \"Message Caye on WhatsApp\" again, or just tell me you'd like to sign up and I'll get you started.",
      `unrecognized-${message.id}`
    )
    if (sendResult.status === 'failed') {
      console.error(`[whatsapp-operator] unrecognized-sender reply failed for from=${fromRaw}:`, sendResult.error)
    }
    return
  }

  // Founder workspace switching: if the caller is a founder AND they've
  // explicitly switched to a workspace via the switch_workspace tool, route
  // to that workspace instead of the most-recent allowlist row. Only applies
  // when the active-workspace pointer is set AND the founder still has a
  // verified founder row on that workspace (defense in depth — a removed
  // founder row shouldn't grant access via stale state).
  if (allow.role === 'founder') {
    const activeKeys = [
      `founder_active_workspace_${normalized}`,
      `founder_active_workspace_+${normalized}`,
    ]
    const { data: activeRow } = await supabase
      .from('platform_settings')
      .select('value')
      .in('key', activeKeys)
      .limit(1)
      .maybeSingle()
    if (activeRow?.value && activeRow.value !== allow.workspace_id) {
      const { data: targetRow } = await supabase
        .from('operator_allowlist')
        .select('id, workspace_id, role, name, verified_at, pending_otp_code, pending_otp_expires_at')
        .or(`phone.eq.${normalized},phone.eq.+${normalized}`)
        .eq('workspace_id', activeRow.value)
        .eq('role', 'founder')
        .limit(1)
        .maybeSingle()
      if (targetRow?.verified_at) {
        allow = targetRow
      } else {
        console.warn(
          `[whatsapp-operator] founder ${fromRaw} has active_workspace=${activeRow.value} but no verified founder row there; falling back to most-recent`
        )
      }
    }
  }

  // Meta includes the sender's WhatsApp profile name alongside inbound
  // messages. A completed onboarding answer is stronger evidence, though:
  // it supplies the person's actual name and repairs the old business-name
  // / "Operator" placeholders used before that answer was copied into the
  // allowlist. An explicitly set personal name still wins.
  const profileName = whatsappProfileName?.trim()
  const { data: customer } = await supabase
    .from('customers')
    .select('full_name, business_name')
    .eq('id', allow.workspace_id)
    .maybeSingle()
  const savedOwnerName = customer?.full_name?.trim() || null
  const preferredName = savedOwnerName || profileName || null
  if (shouldSyncOnboardingOperatorName(allow.name, preferredName, customer?.business_name)) {
    const { error } = await supabase
      .from('operator_allowlist')
      .update({ name: preferredName })
      .eq('id', allow.id)
    if (error) {
      console.error(`[whatsapp-operator] profile-name save failed for operator=${allow.id}:`, error)
    } else {
      allow = { ...allow, name: preferredName }
    }
  }

  // Pending verification (#55) — drop everything except a body that
  // matches the pending OTP. On match, verify the row + send welcome
  // template; on mismatch, drop silently (we don't want to leak the
  // shape of the gate to a wrong-number guess).
  if (!allow.verified_at && allow.pending_otp_code) {
    const expired =
      allow.pending_otp_expires_at &&
      new Date(allow.pending_otp_expires_at).getTime() < Date.now()
    if (expired) {
      console.warn(`[whatsapp-operator] expired pending OTP for from=${fromRaw}`)
      return
    }
    // Accept either a typed reply or a tap on the consent template's "OK"
    // Quick Reply button — Meta delivers a button tap as type: 'button'
    // with the button's label echoed back in .text.
    const body =
      message.type === 'text'
        ? (message.text?.body ?? '').trim()
        : message.type === 'button'
          ? (message.button?.text ?? '').trim()
          : ''
    // Case-insensitive: drivers, and owner/staff once caye_team_consent is
    // approved, confirm with a fixed "OK" reply (any casing). Until then,
    // owner/staff fall back to a numeric code — add-team-member.ts picks
    // whichever pending_otp_code fits, this compare is agnostic either way.
    if (body.toLowerCase() === (allow.pending_otp_code ?? '').toLowerCase()) {
      await supabase
        .from('operator_allowlist')
        .update({
          verified_at: new Date().toISOString(),
          pending_otp_code: null,
          pending_otp_expires_at: null,
        })
        .eq('id', allow.id)
      // Free-form send (no template needed) — the user just messaged us
      // with their OTP, so the 24h window is open. Saves a Meta template.
      const { sendFreeFormWhatsApp } = await import('@/lib/whatsapp/outbound')
      const welcomeBody =
        allow.role === 'driver'
          ? "You're set. I'll text you when there's a pickup for you, with the time and location. Ask me anything about a pickup and I'll do my best — I'll loop in the owner if I can't answer."
          : "You're verified. Welcome aboard.\n\nAnything you need — check bookings, draft a reply, update prices, manage the schedule — just text me."
      await sendFreeFormWhatsApp(
        `+${normalized}`,
        welcomeBody,
        `team-welcome-${allow.workspace_id}-${normalized}-${Date.now()}`
      )
      console.log(`[whatsapp-operator] verified team member from=${fromRaw}`)
    } else {
      console.log(`[whatsapp-operator] dropping message from unverified ${fromRaw}`)
    }
    return
  }

  const workspaceId: string = allow.workspace_id
  const callerRole = allow.role as 'owner' | 'staff' | 'founder' | 'driver'
  const callerName = (allow as { name?: string | null }).name ?? null
  const operatorId: number = allow.id
  const operator = { id: operatorId, name: callerName, role: callerRole }

  // ── Driver mode (2026-07-05) ─────────────────────────────────────────
  // Drivers never go through discovery grill, held-item classification,
  // or the back-office agent — they get their own narrow mode. Branches
  // out here, before any of the owner/staff/founder-shaped logic below.
  if (callerRole === 'driver') {
    const driverReplyTo = `+${normalized}`
    if (message.type !== 'text' || !message.text?.body) {
      return // No media handling for drivers in v1.
    }
    const driverBody = message.text.body.trim()

    await supabase.from('caye_operator_messages').insert({
      workspace_id: workspaceId,
      direction: 'inbound',
      wa_message_id: message.id,
      body: driverBody,
      intent: null,
      claude_format: { role: 'user', content: driverBody },
      operator_allowlist_id: operator.id,
      operator_name: operator.name,
      operator_role: operator.role,
    })

    try {
      const agentResult = await cayeAgent({
        mode: 'driver',
        workspaceId,
        userMessage: driverBody,
        callerRole: 'driver',
        callerName,
        operatorId,
        callerPhone: driverReplyTo,
      })

      let driverSendResult: SendResult | undefined
      if (agentResult.replyText) {
        driverSendResult = await sendFreeFormWhatsApp(
          driverReplyTo,
          agentResult.replyText,
          `driver-${message.id}`
        )
        if (driverSendResult.status === 'failed') {
          console.error(`[whatsapp-operator] driver reply send failed for ${workspaceId}:`, driverSendResult.error)
        }
      }
      await persistAgentTurns(supabase, workspaceId, agentResult.newTurns, operator, driverSendResult)
    } catch (err) {
      console.error(`[whatsapp-operator] driver agent failed for ${workspaceId}:`, err)
      // Don't leave the driver's message unanswered — a thrown error here
      // previously meant total silence with no signal anything went wrong.
      await sendFreeFormWhatsApp(
        driverReplyTo,
        "Sorry, I hit a snag with that — give me a minute and try again.",
        `driver-error-${message.id}`
      ).catch((sendErr) =>
        console.error(`[whatsapp-operator] driver error-fallback send failed for ${workspaceId}:`, sendErr)
      )
    }
    return
  }

  // Fetch the workspace's outbound config (flag + canonical operator
  // number). Separate query from the allowlist lookup so the allowlist
  // is the source of truth for "who can talk to Caye" and the config row
  // is the source of truth for "where do replies go".
  const { data: cfg } = await supabase
    .from('workspace_ai_config')
    .select(
      'whatsapp_outbound_enabled, operator_whatsapp_number, system_prompt, onboarding_wa_question_index, onboarding_wa_answers, onboarding_wa_last_question'
    )
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!cfg) {
    console.warn(`[whatsapp-operator] no workspace_ai_config for workspace=${workspaceId}`)
    return
  }
  const now = new Date().toISOString()

  // Workspace-level stamp — kept for the config dashboard's "last heard
  // from operator" display, but NOT what gates free-form sends anymore
  // (see isWhatsAppWindowOpen). A multi-operator workspace (e.g. Bimini:
  // Lamar, Max, Mrs. Max) would otherwise have any one operator messaging
  // Caye "open the window" for all of them, when Meta actually enforces
  // the 24h window per recipient phone. Confirmed live 2026-07-27.
  await supabase
    .from('workspace_ai_config')
    .update({ last_whatsapp_inbound_at: now })
    .eq('workspace_id', workspaceId)

  // Per-recipient stamp — this is what actually gates free-form sends to
  // THIS operator's phone.
  await supabase
    .from('operator_allowlist')
    .update({ last_inbound_at: now })
    .eq('id', operatorId)

  // ── WhatsApp-native discovery grill ─────────────────────────────────
  // system_prompt is only ever set once (by handleDiscoveryAnswer /
  // saveBusinessProfile) at the end of the adaptive discovery interview
  // (see lib/onboarding.ts:decideNextDiscoveryStep — grill-me-style, one
  // question at a time, stops as soon as there's enough, capped), so its
  // absence means this workspace hasn't finished onboarding yet. This
  // branch runs even though whatsapp_outbound_enabled is still false —
  // that flag flips true only once discovery completes.
  const replyTo = `+${normalized}`
  if (!cfg.system_prompt) {
    // onboarding_wa_last_question is only ever set once a question has
    // actually been sent (see below, and handleDiscoveryAnswer for
    // subsequent turns) — null means Q1 has never gone out, so whatever
    // this message says (however the phone got recognized: cold-start
    // signup, OAuth handoff code, etc.) is "hello," not an answer.
    // Previously this checked onboarding_wa_question_index/_answers, both
    // of which are only written by handleDiscoveryAnswer — since that only
    // runs once discoveryNotStarted is false, nothing ever flipped it, and
    // every reply to Q1 re-triggered this branch forever instead of being
    // recorded as an answer.
    const discoveryNotStarted = cfg.onboarding_wa_last_question == null

    if (discoveryNotStarted) {
      const replyText = firstDiscoveryMessage()
      await supabase
        .from('workspace_ai_config')
        .update({ onboarding_wa_last_question: FIRST_DISCOVERY_QUESTION })
        .eq('workspace_id', workspaceId)
      await supabase.from('caye_operator_messages').insert({
        workspace_id: workspaceId,
        direction: 'inbound',
        wa_message_id: message.id,
        body: message.type === 'text' ? message.text?.body ?? '' : mediaPlaceholder(message.type),
        intent: null,
        operator_allowlist_id: operator.id,
        operator_name: operator.name,
        operator_role: operator.role,
      })
      const sendResult = await sendFreeFormWhatsApp(replyTo, replyText, `discovery-start-${message.id}`)
      if (sendResult.status === 'failed') {
        console.error(`[whatsapp-operator] discovery-start send failed for ${workspaceId}:`, sendResult.error)
      }
      await supabase.from('caye_operator_messages').insert({
        workspace_id: workspaceId,
        direction: 'outbound',
        ...deliveryFieldsFromResult(sendResult),
        body: replyText,
        intent: null,
        operator_allowlist_id: operator.id,
        operator_name: operator.name,
        operator_role: operator.role,
      })
      return
    }

    if (message.type !== 'text' || !message.text?.body) {
      // Non-text reply mid-interview — we only collect answers as text.
      return
    }

    const answerText = message.text.body.trim()
    await supabase.from('caye_operator_messages').insert({
      workspace_id: workspaceId,
      direction: 'inbound',
      wa_message_id: message.id,
      body: answerText,
      intent: null,
      operator_allowlist_id: operator.id,
      operator_name: operator.name,
      operator_role: operator.role,
    })

    const { replyText, completed, businessName } = await handleDiscoveryAnswer(
      supabase,
      workspaceId,
      answerText,
      normalized,
      operatorId
    )
    const sendResult = await sendFreeFormWhatsApp(replyTo, replyText, `discovery-${message.id}`)
    if (sendResult.status === 'failed') {
      console.error(`[whatsapp-operator] discovery send failed for ${workspaceId}:`, sendResult.error)
    }
    await supabase.from('caye_operator_messages').insert({
      workspace_id: workspaceId,
      direction: 'outbound',
      ...deliveryFieldsFromResult(sendResult),
      body: replyText,
      intent: null,
      operator_allowlist_id: operator.id,
      operator_name: operator.name,
      operator_role: operator.role,
    })
    // Fire-and-forget, only once the "you're live" reply above has
    // actually been sent — see handleDiscoveryAnswer for why this can't
    // fire from inside it (races the congratulations send and wins).
    if (completed && businessName) {
      const { sendDemoOffer } = await import('@/lib/caye-demo')
      sendDemoOffer(supabase, workspaceId, replyTo, businessName, operator).catch((err) =>
        console.error(`[whatsapp-operator] demo offer failed for workspace=${workspaceId}:`, err)
      )
    }
    return
  }

  // ── Demo mode (guest-roleplay simulation, 2026-07-22) ────────────────
  // Lets an already-onboarded operator preview Caye's guest-facing voice
  // in this same thread. Runs only once cfg.system_prompt exists (we've
  // fallen through the discovery-grill branch above), so it can never
  // fire mid-onboarding. Intentionally checked before intent
  // classification / legacy dispatch / the back-office agent — a demo
  // turn must never be logged as real back-office conversation or
  // classified as a held-item action. Drivers are excluded (they return
  // earlier, in the driver-mode branch above) — demo mode is for
  // owner/staff/founder only, per the "any operator can trigger it"
  // decision, which didn't extend to the narrow driver persona.
  {
    const demoText =
      message.type === 'text'
        ? (message.text?.body ?? '').trim()
        : message.type === 'button'
          ? (message.button?.text ?? '').trim()
          : ''

    const activeDemo = await getActiveDemoSession(supabase, workspaceId, operatorId)

    if (activeDemo) {
      if (demoText && isDemoExitKeyword(demoText)) {
        await endDemoSession(supabase, activeDemo.id, 'keyword')
        await sendFreeFormWhatsApp(replyTo, DEMO_EXIT_MESSAGE, `demo-exit-${message.id}`)
        return
      }
      if (demoText) {
        const history = await loadDemoHistory(supabase, activeDemo.id)
        // Real name, not the "your business" literal this used to pass —
        // the demo prompt interpolates it into a sentence about whose
        // operator is watching, so the placeholder read as the business
        // actually being called "your business".
        const { data: demoCustomer } = await supabase
          .from('customers')
          .select('business_name')
          .eq('id', workspaceId)
          .maybeSingle()
        // Keep the roleplay grounded in the same owner-taught facts as a
        // real guest reply. This is read-only context: demo mode still
        // never imports the live front-desk tool loop.
        const demoBusinessFacts = await fetchBusinessFacts(workspaceId)
        const cayeReply = await generateDemoReply(
          cfg.system_prompt ?? '',
          demoCustomer?.business_name || 'your business',
          history,
          demoText,
          formatBusinessFactsBlock(demoBusinessFacts)
        )
        await advanceDemoSession(supabase, activeDemo, demoText, cayeReply)
        const sendResult = await sendFreeFormWhatsApp(
          replyTo,
          `🎭 [Demo]\n${cayeReply}`,
          `demo-turn-${message.id}`
        )
        if (sendResult.status === 'failed') {
          console.error(`[whatsapp-operator] demo reply send failed for ${workspaceId}:`, sendResult.error)
        }
      }
      // Non-text turns during an active demo (media, etc.) are just ignored — no media roleplay in v1.
      return
    }

    if (demoText && isDemoEntryKeyword(demoText)) {
      // Logged like the offer that prompted it — the tap itself is a real
      // operator action, not a roleplay turn. Everything from here on
      // (intro message, the roleplay exchange, exit) stays unlogged.
      await supabase.from('caye_operator_messages').insert({
        workspace_id: workspaceId,
        direction: 'inbound',
        wa_message_id: message.id,
        body: demoText,
        intent: null,
        operator_allowlist_id: operator.id,
        operator_name: operator.name,
        operator_role: operator.role,
      })
      await startDemoSession(supabase, workspaceId, operatorId, replyTo)
      await sendFreeFormWhatsApp(replyTo, DEMO_INTRO_MESSAGE, `demo-start-${message.id}`)
      return
    }
  }

  // ── Image messages (screenshots/photos, 2026-07-24) ──────────────────
  // Skips intent classification entirely (images are never held-item
  // actions) and goes straight to the back-office agent as a vision turn.
  if (message.type === 'image' && message.image) {
    await handleImageInbound(supabase, {
      message,
      workspaceId,
      operator,
      operatorId,
      callerRole,
      callerName,
      replyTo,
      whatsappOutboundEnabled: cfg.whatsapp_outbound_enabled,
    })
    return
  }

  if (message.type !== 'text' || !message.text?.body) {
    // Non-text, non-image — just log and bail. We don't classify other media in v1.
    await supabase.from('caye_operator_messages').insert({
      workspace_id: workspaceId,
      direction: 'inbound',
      wa_message_id: message.id,
      body: mediaPlaceholder(message.type),
      intent: null,
      operator_allowlist_id: operator.id,
      operator_name: operator.name,
      operator_role: operator.role,
    })
    return
  }

  const body = message.text.body.trim()

  // Scoped acknowledgement (2026-08-13): a genuine operator reply resolves
  // the SPECIFIC attention item(s) it addresses, never every open item in
  // the workspace — see lib/whatsapp/attention-acknowledgement.ts for why a
  // bare "what's on Saturday?" must not clear an unrelated Karin Roberts
  // reminder. Best-effort and never blocks the real reply below.
  try {
    const acked = await resolveAcknowledgedAttentionItems({
      workspaceId,
      replyToMessageId: message.context?.id ?? null,
      bodyText: body,
    })
    if (acked.length > 0) await acknowledgeAttentionItems(workspaceId, acked)
  } catch (err) {
    console.error(`[whatsapp-operator] attention acknowledgement failed for ${workspaceId}:`, err)
  }

  // Classify against current pending state.
  const pending = await getPendingHeldItems(workspaceId)

  // Always fetch what Caye last said to this operator — not just when they
  // used WhatsApp's reply-to. Gating this on message.context?.id meant a bare
  // "yes please" typed normally reached the classifier with no idea Caye had
  // just asked "Send that?", so with several items in the held queue the only
  // sane classification left was unclear → "which item? (1-6)". That is what
  // made a plain confirmation feel broken (Karenda, 2026-08-07).
  const { data: lastRow } = await supabase
    .from('caye_operator_messages')
    .select('body, claude_format')
    .eq('workspace_id', workspaceId)
    .eq('operator_allowlist_id', operatorId)
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const lastOutboundBody: string | null = lastRow?.body ?? null

  const rawIntent = await classifyOperatorIntent({
    operatorText: body,
    pending,
    lastCayeOutboundBody: lastOutboundBody,
    quotedMessage: null,
  })

  // Strip an item_ref the operator never gave. The classifier answered a bare
  // "Yes" with item_ref="1" — position 1 being an unrelated contact it had no
  // basis to pick (2026-08-07). Dropping it makes the action handlers ask
  // "which one?" instead of acting on a guess. See lib/whatsapp/item-ref-guard.
  const guardRef = (one: SingleOperatorIntent): SingleOperatorIntent => {
    if (!('item_ref' in one)) return one
    const { itemRef, reason } = corroborateItemRef({
      itemRef: one.item_ref,
      operatorText: body,
      lastOutboundBody,
      pending,
    })
    if (reason) console.warn(`[whatsapp-operator] ${workspaceId}: ${reason} — dropped`)
    return { ...one, item_ref: itemRef }
  }
  const intent: OperatorIntent =
    rawIntent.kind === 'multi'
      ? { ...rawIntent, actions: rawIntent.actions.map(guardRef) }
      : rawIntent.kind === 'unclear'
        ? rawIntent // carries no item_ref
        : guardRef(rawIntent)

  // Persist inbound + classified intent + claude_format for the user turn.
  // claude_format is what the back-office agent's sliding-window loader
  // consumes; we populate it for every inbound regardless of routing path
  // so the agent has full history when it does run.
  const { data: persistedInbound } = await supabase
    .from('caye_operator_messages')
    .insert({
      workspace_id: workspaceId,
      direction: 'inbound',
      wa_message_id: message.id,
      body,
      intent,
      claude_format: { role: 'user', content: body },
      operator_allowlist_id: operator.id,
      operator_name: operator.name,
      operator_role: operator.role,
    })
    .select('id')
    .single()

  // Operator Learning Router: capture durable knowledge from this verified
  // operator boundary independent of whether the back-office agent, later in
  // this same turn, happens to call a write tool itself. Deliberately NOT
  // awaited — same fire-and-forget convention as maybeSuggestBusinessFacts
  // (lib/business-fact-suggestions.ts) — so a classifier/write failure can
  // never delay or break the operator's reply. Customer messages never reach
  // this call site at all; it is only wired into this operator webhook.
  routeOperatorLearningCorrection({
    workspaceId,
    operatorId: operator.id,
    operatorRole: operator.role,
    operatorText: body,
    previousCayeText: lastOutboundBody,
    sourceMessageId: persistedInbound?.id ?? null,
    sourceConversationId: `operator:${operator.id}`,
  }).catch((err) => console.error('[whatsapp-operator] operator-learning-router failed:', err))

  // If the workspace flag is off we don't act on intents — but we still logged
  // and stamped the window. This means flipping the flag back on doesn't replay
  // stale instructions.
  if (!cfg.whatsapp_outbound_enabled) {
    console.log(`[whatsapp-operator] flag off for ${workspaceId} — skipping action`)
    return
  }

  // ── Routing decision ───────────────────────────────────────────────
  // Held-item action kinds take the legacy classifier+dispatch path ONLY
  // when the agent isn't already mid-conversation with this operator (see
  // the ownership check below). Everything else (query / unclear) routes
  // through the back-office agent — slice 1 of epic #35.
  // Reply destination: send back to whoever messaged us, NOT to the
  // workspace's canonical operator number. Critical for founders DMing on
  // a workspace they don't own (e.g. Lamar texting Caye about Bimini —
  // without this, Caye's reply was going to Karenda's phone). For owners
  // the inbound number == operator_whatsapp_number anyway, so this is a
  // no-op for them. Carries a leading + because Meta returns the from
  // without it but our send helper expects the canonical form.
  // (replyTo was already declared above the discovery-grill branch.)

  // Ownership beats the intent label. The classifier decides WHAT the operator
  // means; it does not get to decide who the reply belongs to. When the agent
  // has a staged action awaiting confirmation, or simply spoke last, the reply
  // is part of that conversation — routing it to the legacy held-queue path
  // silently orphaned a correct staged send (2026-08-07). See
  // lib/whatsapp/turn-ownership.ts for the full trace.
  const ownership = await resolveTurnOwner({
    supabase,
    workspaceId,
    operatorId,
    lastOutboundClaudeFormat: lastRow?.claude_format ?? null,
  })

  // Completion statements resolve against the task Caye just named before
  // the workspace-wide held queue gets a chance to contaminate the turn.
  // This includes expired authorizations: expiry removes permission to send,
  // not the durable identity of what the operator and Caye were discussing.
  if (intent.kind === 'handled' || isOwnerCompletionStatement(body)) {
    const activeTask = await resolveActiveOwnerTask({
      supabase,
      workspaceId,
      operatorId,
      explicitRef: intent.kind === 'handled' ? intent.item_ref : undefined,
      previousCayeMessage: lastOutboundBody,
    })
    if (activeTask.status === 'matched') {
      const completed = await markOwnerTaskHandled({
        supabase,
        task: activeTask.task,
        operatorId,
        note: 'operator reported completing this outside Caye',
      })
      const ackBody = completed.ok
        ? ownerHandledAcknowledgement(activeTask.task)
        : `I found the task, but couldn't mark it handled: ${completed.error}`
      const ackSendResult = await sendFreeFormWhatsApp(replyTo, ackBody, `owner-handled-${message.id}`)
      await supabase.from('caye_operator_messages').insert({
        workspace_id: workspaceId,
        direction: 'outbound',
        ...deliveryFieldsFromResult(ackSendResult),
        body: ackBody,
        intent: null,
        claude_format: { role: 'assistant', content: ackBody },
        operator_allowlist_id: operator.id,
        operator_name: operator.name,
        operator_role: operator.role,
      })
      return
    }
    // Multiple real matches remain ambiguous. Do not fall through to the
    // unrelated held queue; name only the conversational task candidates.
    if (activeTask.status === 'ambiguous') {
      const choices = activeTask.tasks.map((task, i) => `${i + 1}. ${task.customerName || task.customerId || task.summary}`).join(' / ')
      const ackBody = `Which one did you handle? ${choices}`
      const ackSendResult = await sendFreeFormWhatsApp(replyTo, ackBody, `owner-handled-choice-${message.id}`)
      await supabase.from('caye_operator_messages').insert({
        workspace_id: workspaceId, direction: 'outbound', ...deliveryFieldsFromResult(ackSendResult),
        body: ackBody, intent: null, claude_format: { role: 'assistant', content: ackBody },
        operator_allowlist_id: operator.id, operator_name: operator.name, operator_role: operator.role,
      })
      return
    }
  }

  // A send/edit naming a target that isn't in the CURRENT held queue must
  // not fall into the legacy path's "which one?" — that path only ever
  // knows the held queue, never the customer the operator and Caye already
  // discussed earlier in this same conversation (CAY-90, Christopher/GGT
  // incident: legacy asked Mrs. Max to identify a thread the agent's own
  // sliding-window memory already had). Defer to the back-office agent
  // instead, which can search full history and ask a grounded question only
  // if genuinely ambiguous.
  const namedTargetRef =
    intent.kind === 'send' || intent.kind === 'edit' ? intent.item_ref : undefined
  const legacyTargetMissing = namesUnresolvedTarget(pending, namedTargetRef)
  if (legacyTargetMissing) {
    console.warn(
      `[whatsapp-operator] ${workspaceId}: item_ref "${namedTargetRef}" not in held queue — deferring ${intent.kind} to back-office agent`
    )
  }

  if (LEGACY_DISPATCH_KINDS.has(intent.kind) && ownership.owner === 'legacy' && !legacyTargetMissing) {
    const result = await dispatchOperatorIntent({ workspaceId }, intent, pending)
    if (result.ackBody && result.ackBody.trim()) {
      // Send ack synchronously instead of via the outbound queue. The
      // operator JUST messaged us so the 24h window is open — no template
      // needed, no queue drain delay. Mirrors the back-office agent path
      // below. Previously acks queued as kind='ack' and waited up to a
      // full outbound-worker tick to send (observed 4-min delays in live
      // testing, which destroys the chat flow).
      let ackSendResult: SendResult | undefined
      if (replyTo) {
        ackSendResult = await sendFreeFormWhatsApp(
          replyTo,
          result.ackBody,
          `ack-${message.id}`
        )
        if (ackSendResult.status === 'failed') {
          console.error(
            `[whatsapp-operator] ack send failed for ${workspaceId}:`,
            ackSendResult.error
          )
        }
      } else {
        console.warn(
          `[whatsapp-operator] no reply destination resolved for caller on workspace ${workspaceId}; ack produced but not sent`
        )
      }
      await supabase.from('caye_operator_messages').insert({
        workspace_id: workspaceId,
        direction: 'outbound',
        ...(ackSendResult
          ? deliveryFieldsFromResult(ackSendResult)
          : { wa_message_id: null, wa_delivery_status: null, wa_delivery_error: null }),
        body: result.ackBody,
        intent: null,
        claude_format: { role: 'assistant', content: result.ackBody },
        operator_allowlist_id: operator.id,
        operator_name: operator.name,
        operator_role: operator.role,
      })
    }
    return
  }

  // ── Back-office agent path ─────────────────────────────────────────
  try {
    // Only the FINAL assistant turn is sent over WhatsApp, so a turn that
    // spends 20-60s in the tool loop (bulk lead drafting, send_outreach_batch)
    // leaves the operator staring at nothing. One fixed heartbeat, only once
    // the turn has already proven slow — see lib/whatsapp/slow-turn-heartbeat.
    const agentResult = await withSlowTurnHeartbeat(
      () =>
        cayeAgent({
          mode: 'back-office',
          workspaceId,
          userMessage: body,
          callerRole,
          callerName,
          operatorId,
        }),
      {
        onSlow: async (stillRunning) => {
          if (!replyTo || !stillRunning()) return
          const heartbeat = "Still on it — one sec."
          const sendResult = await sendFreeFormWhatsApp(
            replyTo,
            heartbeat,
            `back-office-heartbeat-${message.id}`
          )
          // Persist so Caye Direct shows the same thing the operator got.
          await supabase.from('caye_operator_messages').insert({
            workspace_id: workspaceId,
            direction: 'outbound',
            ...deliveryFieldsFromResult(sendResult),
            body: heartbeat,
            intent: null,
            // No claude_format: this is ours, not a model turn, and it must
            // not enter the agent's replayed history as something it said.
            operator_allowlist_id: operator.id,
            operator_name: operator.name,
            operator_role: operator.role,
          })
        },
      }
    )

    if (!agentResult.replyText) {
      // Same failure mode as the catch block below: the model finished its
      // turn with no text and no tool_use (seen live on terse messages like
      // "Yo" dropped into a long tool-heavy history — 2026-08-04, 2026-08-06).
      // Previously this just warned server-side and returned, leaving the
      // operator with silence indistinguishable from "ignored." Always
      // surface something.
      console.warn(
        `[whatsapp-operator] empty reply from back-office agent for ${workspaceId}`
      )
      let emptyReplySendResult: SendResult | undefined
      if (replyTo) {
        emptyReplySendResult = await sendFreeFormWhatsApp(
          replyTo,
          "Didn't quite catch what you need there — can you say a bit more?",
          `back-office-empty-${message.id}`
        )
        if (emptyReplySendResult.status === 'failed') {
          console.error(
            `[whatsapp-operator] empty-reply fallback send failed for ${workspaceId}:`,
            emptyReplySendResult.error
          )
        }
      }
      const insertedEmpty = await persistAgentTurns(supabase, workspaceId, agentResult.newTurns, operator, emptyReplySendResult)
      await linkInsertedMessagesToThreads(supabase, insertedEmpty.map((r) => r.id), agentResult.linkedThreadIds)
      return
    }

    // Send back-office replies synchronously instead of via the queue.
    // Reply destination is the CALLER (replyTo, set above), not the
    // workspace's canonical operator number — critical for founders DMing
    // on a workspace they don't own.
    let backOfficeSendResult: SendResult | undefined
    if (replyTo) {
      backOfficeSendResult = await sendFreeFormWhatsApp(
        replyTo,
        agentResult.replyText,
        `back-office-${message.id}`
      )
      if (backOfficeSendResult.status === 'failed') {
        console.error(
          `[whatsapp-operator] Meta send failed for ${workspaceId}:`,
          backOfficeSendResult.error,
          { transient: backOfficeSendResult.transient, blocked: backOfficeSendResult.blocked }
        )
      }
    } else {
      console.warn(
        `[whatsapp-operator] no reply destination resolved for caller on workspace ${workspaceId}; reply produced but not sent`
      )
    }

    // Persist every turn produced during the tool loop (intermediate
    // assistant turns with tool_use blocks, intermediate user turns
    // with tool_result blocks, and the final assistant text turn) so
    // the sliding-window loader sees them on the next round. Shared with
    // the web-based Caye Direct route (app/api/founder/caye-direct) so
    // both persist identically — that route never sends over WhatsApp, so
    // it always calls this with no finalSendResult.
    const insertedBackOffice = await persistAgentTurns(supabase, workspaceId, agentResult.newTurns, operator, backOfficeSendResult)
    await linkInsertedMessagesToThreads(supabase, insertedBackOffice.map((r) => r.id), agentResult.linkedThreadIds)
  } catch (err) {
    console.error(
      `[whatsapp-operator] back-office agent failed for ${workspaceId}:`,
      err
    )
    // A thrown error here previously left the operator with silence — no
    // way to tell "Caye is thinking" from "Caye is broken" from "Caye
    // ignored me." Always surface something, even on hard failure.
    if (replyTo) {
      await sendFreeFormWhatsApp(
        replyTo,
        "Sorry, I hit a snag with that — give me a minute and try again.",
        `back-office-error-${message.id}`
      ).catch((sendErr) =>
        console.error(`[whatsapp-operator] error-fallback send failed for ${workspaceId}:`, sendErr)
      )
    }
  }
}

// ─── Image inbound (2026-07-24) ──────────────────────────────────────────
//
// Screenshots/photos sent to Caye Direct. Downloaded from WhatsApp's Cloud
// API and passed to the back-office agent as an Anthropic vision content
// block, the same way an image attachment works in Claude.ai.
//
// claude_format for the persisted inbound row deliberately stores a text
// placeholder, not the real image bytes: loadOperatorContext replays
// claude_format verbatim on every future turn in the sliding window, and
// an image's base64 payload is 100x+ heavier than a text turn. The real
// bytes are only ever sent to the model on the turn they arrive.

interface ImageInboundParams {
  message: WaInboundMessage
  workspaceId: string
  operator: { id: number; name: string | null; role: 'owner' | 'staff' | 'founder' | 'driver' }
  operatorId: number
  callerRole: 'owner' | 'staff' | 'founder' | 'driver'
  callerName: string | null
  replyTo: string
  whatsappOutboundEnabled: boolean | null
}

async function handleImageInbound(
  supabase: ReturnType<typeof createServiceClient>,
  params: ImageInboundParams
): Promise<void> {
  const { message, workspaceId, operator, operatorId, callerRole, callerName, replyTo, whatsappOutboundEnabled } =
    params
  const image = message.image!
  const caption = image.caption?.trim() || null
  const placeholderBody = caption ? `[image: ${caption}]` : '[image]'

  // Is this one photo in a burst? Read the previous image from this operator
  // BEFORE inserting this one, so the lookup can't find the current row.
  const { data: priorImage } = await supabase
    .from('caye_operator_messages')
    .select('created_at')
    .eq('workspace_id', workspaceId)
    .eq('operator_allowlist_id', operator.id)
    .eq('direction', 'inbound')
    .like('body', '[image%')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const burst = decideImageBurst({
    previousImageAt: priorImage?.created_at ? new Date(priorImage.created_at as string) : null,
    now: new Date(),
    hasCaption: !!caption,
  })

  await supabase.from('caye_operator_messages').insert({
    workspace_id: workspaceId,
    direction: 'inbound',
    wa_message_id: message.id,
    body: placeholderBody,
    intent: null,
    claude_format: { role: 'user', content: placeholderBody },
    operator_allowlist_id: operator.id,
    operator_name: operator.name,
    operator_role: operator.role,
  })

  // Mid-burst: the row is persisted (so the next turn's context knows the
  // photos arrived) but Caye says nothing. Acknowledging each photo
  // individually is what produced eleven near-identical replies with a
  // miscounted running total on 2026-08-09 — see decideImageBurst.
  //
  // Trade-off, deliberately taken: the model only ever receives image bytes
  // on the turn they arrive (claude_format persists a text placeholder — see
  // the block comment above), so a silently-collected image is never seen.
  // The operator's next message is what says what to do with the batch, and
  // that message is answered with full knowledge of how many arrived. A
  // captioned image is always answered, which is the escape hatch when a
  // specific photo needs looking at.
  if (!burst.respond) {
    console.log(
      `[whatsapp-operator] image burst for ${workspaceId} — ${burst.reason}, staying quiet`
    )
    return
  }

  if (!isSupportedImageMimeType(image.mime_type)) {
    await sendFreeFormWhatsApp(
      replyTo,
      `Can't read that file type (${image.mime_type}) — send it as a JPEG, PNG, GIF, or WebP.`,
      `image-unsupported-${message.id}`
    )
    return
  }

  // Same outbound gate as the text path: log it, but don't act on it, if
  // the workspace flag is off.
  if (!whatsappOutboundEnabled) {
    console.log(`[whatsapp-operator] flag off for ${workspaceId} — skipping image action`)
    return
  }

  let content: Anthropic.MessageParam['content']
  try {
    const { base64, mimeType } = await downloadWhatsAppMedia(image.id)
    if (!isSupportedImageMimeType(mimeType)) {
      // Rare: differs from the mime_type Meta reported on the webhook
      // payload. Treat the same as an unsupported type up front.
      await sendFreeFormWhatsApp(
        replyTo,
        `Can't read that file type (${mimeType}) — send it as a JPEG, PNG, GIF, or WebP.`,
        `image-unsupported-download-${message.id}`
      )
      return
    }
    content = [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
      ...(caption ? [{ type: 'text' as const, text: caption }] : []),
    ]
  } catch (err) {
    console.error(`[whatsapp-operator] image download failed for ${workspaceId}:`, err)
    await sendFreeFormWhatsApp(
      replyTo,
      "Couldn't pull that image down — try sending it again?",
      `image-download-error-${message.id}`
    )
    return
  }

  try {
    const agentResult = await cayeAgent({
      mode: 'back-office',
      workspaceId,
      userMessage: content,
      callerRole,
      callerName,
      operatorId,
    })

    if (!agentResult.replyText) {
      console.warn(`[whatsapp-operator] empty reply from back-office agent (image) for ${workspaceId}`)
      return
    }

    const sendResult = await sendFreeFormWhatsApp(
      replyTo,
      agentResult.replyText,
      `back-office-image-${message.id}`
    )
    if (sendResult.status === 'failed') {
      console.error(`[whatsapp-operator] Meta send failed (image) for ${workspaceId}:`, sendResult.error)
    }

    const insertedImage = await persistAgentTurns(supabase, workspaceId, agentResult.newTurns, operator, sendResult)
    await linkInsertedMessagesToThreads(supabase, insertedImage.map((r) => r.id), agentResult.linkedThreadIds)
  } catch (err) {
    console.error(`[whatsapp-operator] back-office agent failed (image) for ${workspaceId}:`, err)
    await sendFreeFormWhatsApp(
      replyTo,
      "Sorry, I hit a snag with that image — give me a minute and try again.",
      `back-office-image-error-${message.id}`
    ).catch((sendErr) =>
      console.error(`[whatsapp-operator] image error-fallback send failed for ${workspaceId}:`, sendErr)
    )
  }
}

// ─── Sales demo mode ──────────────────────────────────────────────────────
//
// A founder-pre-registered prospect (demo_prospects row) texts Caye's
// platform number and gets a live front-desk-persona reply — same
// generateCayeAutoReply engine real customers get, seeded with a demo
// workspace's system prompt (their own tour catalog), with real
// multi-turn memory via the same unified_conversations/unified_messages
// tables the production front-desk channel uses. No Meta business
// connection required on the prospect's side; the reply ships from
// Caye's own platform WhatsApp number via sendFreeFormWhatsApp.
//
// Returns true if this phone was a registered demo prospect (caller
// should stop processing — never fall through to cold-start/onboarding).
async function tryHandleDemoProspect(
  supabase: ReturnType<typeof createServiceClient>,
  normalizedPhone: string,
  message: WaInboundMessage
): Promise<boolean> {
  const { data: prospect } = await supabase
    .from('demo_prospects')
    .select('demo_workspace_id, label')
    .eq('phone', normalizedPhone)
    .maybeSingle()

  if (!prospect) return false

  const workspaceId = prospect.demo_workspace_id as string
  const body = message.text?.body ?? ''

  const [{ data: config }, { data: account }] = await Promise.all([
    supabase
      .from('workspace_ai_config')
      .select('system_prompt')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    supabase
      .from('connected_accounts')
      .select('id')
      .eq('user_id', workspaceId)
      .eq('channel_type', 'whatsapp')
      .maybeSingle(),
  ])

  if (!config?.system_prompt || !account) {
    console.error(`[whatsapp-operator] demo prospect ${normalizedPhone} missing seed data (workspace ${workspaceId})`)
    return true // still true — don't fall through to real signup for a known demo number
  }

  // Upsert the demo conversation thread, same shape the real front-desk
  // webhook (app/api/webhooks/whatsapp/route.ts) uses.
  const { data: conversation, error: convErr } = await supabase
    .from('unified_conversations')
    .upsert(
      {
        connected_account_id: account.id,
        channel_type: 'whatsapp',
        channel_conversation_id: `+${normalizedPhone}`,
        customer_name: prospect.label ?? 'Demo prospect',
        customer_id: `+${normalizedPhone}`,
        status: 'open',
        last_message_at: new Date().toISOString(),
        last_message_preview: body.slice(0, 100),
        last_sender_type: 'customer',
        metadata: { demo: true },
      },
      { onConflict: 'connected_account_id,channel_conversation_id' }
    )
    .select('id')
    .single()

  if (convErr || !conversation) {
    console.error(`[whatsapp-operator] demo conversation upsert failed for ${normalizedPhone}:`, convErr)
    return true
  }

  await supabase.from('unified_messages').insert({
    conversation_id: conversation.id,
    channel_message_id: message.id,
    sender_type: 'customer',
    content: body,
    message_type: 'text',
    sent_at: new Date().toISOString(),
    status: 'delivered',
    metadata: { demo: true },
  })

  let decision: Awaited<ReturnType<typeof generateCayeAutoReply>>
  try {
    decision = await generateCayeAutoReply(config.system_prompt, {
      senderName: prospect.label ?? 'Demo prospect',
      body,
      channel: 'whatsapp',
      workspaceId,
      conversationId: conversation.id,
      currentChannelMessageId: message.id,
    })
  } catch (err) {
    console.error(`[whatsapp-operator] demo reply generation failed for ${normalizedPhone}:`, err)
    await sendFreeFormWhatsApp(
      `+${normalizedPhone}`,
      "Sorry, I hit a snag there — try that again in a moment?",
      `demo-error-${message.id}`
    )
    return true
  }

  // No real operator exists to escalate to for a demo workspace, so a
  // silent hold (correct in production — the operator sees it in their
  // queue) would just look broken here. Prefer customerAcknowledgement
  // (identity-guarded, safe to send verbatim); fall back to the
  // operator-facing proposedReply rather than go silent, since there's
  // no operator to rescue it either way.
  const replyText =
    decision.action === 'hold'
      ? decision.customerAcknowledgement ??
        decision.proposedReply ??
        'I need a team member to check that detail before I can answer.'
      : decision.content

  const sendResult = await sendFreeFormWhatsApp(`+${normalizedPhone}`, replyText, `demo-${message.id}`)
  if (sendResult.status === 'failed') {
    console.error(`[whatsapp-operator] demo reply send failed for ${normalizedPhone}:`, sendResult.error)
  }

  await supabase.from('unified_messages').insert({
    conversation_id: conversation.id,
    channel_message_id: `demo_${Date.now()}`,
    sender_type: 'business',
    content: replyText,
    message_type: 'text',
    sent_at: new Date().toISOString(),
    status: 'sent',
    metadata: { demo: true, generated_by: 'caye' },
  })

  return true
}
