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
import { createServiceClient } from '@/lib/supabase-server'
import { classifyOperatorIntent } from '@/lib/whatsapp/intent'
import { getPendingHeldItems } from '@/lib/whatsapp/pending'
import { dispatchOperatorIntent } from '@/lib/whatsapp/actions'
import { sendFreeFormWhatsApp } from '@/lib/whatsapp/outbound'
import { cayeAgent } from '@/lib/caye-agent'
import {
  extractSignupCode,
  tryAutoProvisionOwner,
  firstDiscoveryMessage,
  handleDiscoveryAnswer,
  normalizeE164,
} from '@/lib/onboarding-whatsapp'

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
    // First contact from an unrecognized phone — fallback path in case
    // they messaged from a phone that wasn't pre-registered via the
    // /onboarding phone step (e.g. an old shared link). Check for a
    // signup deep-link code before giving up.
    const bodyText = message.type === 'text' ? message.text?.body ?? '' : ''
    const signupWorkspaceId = extractSignupCode(bodyText)
    if (signupWorkspaceId) {
      const provisioned = await tryAutoProvisionOwner(supabase, signupWorkspaceId, normalized)
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
  }

  if (!allow) {
    console.warn(`[whatsapp-operator] no allowlist entry for from=${fromRaw}`)
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
    const body = message.type === 'text' ? (message.text?.body ?? '').trim() : ''
    if (body === allow.pending_otp_code) {
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
      await sendFreeFormWhatsApp(
        `+${normalized}`,
        "You're verified. Welcome aboard.\n\nAnything you need — check bookings, draft a reply, update prices, manage the schedule — just text me.",
        `team-welcome-${allow.workspace_id}-${normalized}-${Date.now()}`
      )
      console.log(`[whatsapp-operator] verified team member from=${fromRaw}`)
    } else {
      console.log(`[whatsapp-operator] dropping message from unverified ${fromRaw}`)
    }
    return
  }

  const workspaceId: string = allow.workspace_id
  const callerRole = allow.role as 'owner' | 'staff' | 'founder'
  const callerName = (allow as { name?: string | null }).name ?? null

  // Fetch the workspace's outbound config (flag + canonical operator
  // number). Separate query from the allowlist lookup so the allowlist
  // is the source of truth for "who can talk to Caye" and the config row
  // is the source of truth for "where do replies go".
  const { data: cfg } = await supabase
    .from('workspace_ai_config')
    .select(
      'whatsapp_outbound_enabled, operator_whatsapp_number, system_prompt, onboarding_wa_question_index, onboarding_wa_answers'
    )
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!cfg) {
    console.warn(`[whatsapp-operator] no workspace_ai_config for workspace=${workspaceId}`)
    return
  }
  const now = new Date().toISOString()

  // Open the 24h free-form window regardless of message type.
  await supabase
    .from('workspace_ai_config')
    .update({ last_whatsapp_inbound_at: now })
    .eq('workspace_id', workspaceId)

  // ── WhatsApp-native discovery grill ─────────────────────────────────
  // system_prompt is only ever set once (by handleDiscoveryAnswer /
  // saveBusinessProfile) at the end of the 8-question interview, so its
  // absence means this workspace hasn't finished onboarding yet. This
  // branch runs even though whatsapp_outbound_enabled is still false —
  // that flag flips true only once discovery completes.
  const replyTo = `+${normalized}`
  if (!cfg.system_prompt) {
    // Question index still at 0 with no answers recorded means discovery
    // hasn't actually started yet — whatever this first message says
    // (however the phone got recognized: pre-registered via /onboarding's
    // phone step, or the [ws:...] code fallback), treat it as "hello,"
    // not as an answer to question 1.
    const discoveryNotStarted =
      (cfg.onboarding_wa_question_index ?? 0) === 0 &&
      Object.keys(cfg.onboarding_wa_answers ?? {}).length === 0

    if (discoveryNotStarted) {
      const replyText = firstDiscoveryMessage()
      await supabase.from('caye_operator_messages').insert({
        workspace_id: workspaceId,
        direction: 'inbound',
        wa_message_id: message.id,
        body: message.type === 'text' ? message.text?.body ?? '' : `[${message.type}]`,
        intent: null,
      })
      const sendResult = await sendFreeFormWhatsApp(replyTo, replyText, `discovery-start-${message.id}`)
      if (sendResult.status === 'failed') {
        console.error(`[whatsapp-operator] discovery-start send failed for ${workspaceId}:`, sendResult.error)
      }
      await supabase.from('caye_operator_messages').insert({
        workspace_id: workspaceId,
        direction: 'outbound',
        wa_message_id: null,
        body: replyText,
        intent: null,
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
    })

    const { replyText } = await handleDiscoveryAnswer(supabase, workspaceId, answerText)
    const sendResult = await sendFreeFormWhatsApp(replyTo, replyText, `discovery-${message.id}`)
    if (sendResult.status === 'failed') {
      console.error(`[whatsapp-operator] discovery send failed for ${workspaceId}:`, sendResult.error)
    }
    await supabase.from('caye_operator_messages').insert({
      workspace_id: workspaceId,
      direction: 'outbound',
      wa_message_id: null,
      body: replyText,
      intent: null,
    })
    return
  }

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

  // Persist inbound + classified intent + claude_format for the user turn.
  // claude_format is what the back-office agent's sliding-window loader
  // consumes; we populate it for every inbound regardless of routing path
  // so the agent has full history when it does run.
  await supabase.from('caye_operator_messages').insert({
    workspace_id: workspaceId,
    direction: 'inbound',
    wa_message_id: message.id,
    body,
    intent,
    claude_format: { role: 'user', content: body },
  })

  // If the workspace flag is off we don't act on intents — but we still logged
  // and stamped the window. This means flipping the flag back on doesn't replay
  // stale instructions.
  if (!cfg.whatsapp_outbound_enabled) {
    console.log(`[whatsapp-operator] flag off for ${workspaceId} — skipping action`)
    return
  }

  // ── Routing decision ───────────────────────────────────────────────
  // Held-item action kinds keep the legacy classifier+dispatch path.
  // Everything else (query / unclear) routes through the new
  // back-office agent — slice 1 of epic #35.
  // Reply destination: send back to whoever messaged us, NOT to the
  // workspace's canonical operator number. Critical for founders DMing on
  // a workspace they don't own (e.g. Lamar texting Caye about Bimini —
  // without this, Caye's reply was going to Karenda's phone). For owners
  // the inbound number == operator_whatsapp_number anyway, so this is a
  // no-op for them. Carries a leading + because Meta returns the from
  // without it but our send helper expects the canonical form.
  // (replyTo was already declared above the discovery-grill branch.)

  if (LEGACY_DISPATCH_KINDS.has(intent.kind)) {
    const result = await dispatchOperatorIntent({ workspaceId }, intent, pending)
    if (result.ackBody && result.ackBody.trim()) {
      // Send ack synchronously instead of via the outbound queue. The
      // operator JUST messaged us so the 24h window is open — no template
      // needed, no queue drain delay. Mirrors the back-office agent path
      // below. Previously acks queued as kind='ack' and waited up to a
      // full outbound-worker tick to send (observed 4-min delays in live
      // testing, which destroys the chat flow).
      if (replyTo) {
        const sendResult = await sendFreeFormWhatsApp(
          replyTo,
          result.ackBody,
          `ack-${message.id}`
        )
        if (sendResult.status === 'failed') {
          console.error(
            `[whatsapp-operator] ack send failed for ${workspaceId}:`,
            sendResult.error
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
        wa_message_id: null,
        body: result.ackBody,
        intent: null,
        claude_format: { role: 'assistant', content: result.ackBody },
      })
    }
    return
  }

  // ── Back-office agent path ─────────────────────────────────────────
  try {
    const agentResult = await cayeAgent({
      mode: 'back-office',
      workspaceId,
      userMessage: body,
      callerRole,
      callerName,
    })

    if (!agentResult.replyText) {
      console.warn(
        `[whatsapp-operator] empty reply from back-office agent for ${workspaceId}`
      )
      return
    }

    // Send back-office replies synchronously instead of via the queue.
    // Reply destination is the CALLER (replyTo, set above), not the
    // workspace's canonical operator number — critical for founders DMing
    // on a workspace they don't own.
    if (replyTo) {
      const sendResult = await sendFreeFormWhatsApp(
        replyTo,
        agentResult.replyText,
        `back-office-${message.id}`
      )
      if (sendResult.status === 'failed') {
        console.error(
          `[whatsapp-operator] Meta send failed for ${workspaceId}:`,
          sendResult.error,
          { transient: sendResult.transient, blocked: sendResult.blocked }
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
    // the sliding-window loader sees them on the next round.
    //
    // direction maps from the MessageParam role: assistant→outbound,
    // user→inbound. The body field gets a short human-readable summary
    // for tool turns so the audit log isn't a wall of JSON.
    for (const turn of agentResult.newTurns) {
      const direction = turn.role === 'assistant' ? 'outbound' : 'inbound'
      const bodySummary = summarizeTurnBody(turn)
      await supabase.from('caye_operator_messages').insert({
        workspace_id: workspaceId,
        direction,
        wa_message_id: null,
        body: bodySummary,
        intent: null,
        claude_format: turn,
      })
    }
  } catch (err) {
    console.error(
      `[whatsapp-operator] back-office agent failed for ${workspaceId}:`,
      err
    )
  }
}

/**
 * Render a one-line body summary for a Claude MessageParam — used for
 * the audit-friendly `body` column on caye_operator_messages. Real
 * Claude shape lives in `claude_format`.
 */
function summarizeTurnBody(turn: import('@anthropic-ai/sdk').default.MessageParam): string {
  if (typeof turn.content === 'string') return turn.content
  const parts: string[] = []
  for (const block of turn.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool_use') parts.push(`[tool_use: ${block.name}]`)
    else if (block.type === 'tool_result') parts.push(`[tool_result]`)
  }
  return parts.join(' ').trim() || '[empty]'
}
