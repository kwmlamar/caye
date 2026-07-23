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
import { generateCayeAutoReply } from '@/lib/caye-reply'
import { cayeAgent } from '@/lib/caye-agent'
import { persistAgentTurns } from '@/lib/caye-operator-messages'
import {
  extractSignupCode,
  tryAutoProvisionOwner,
  tryColdStartWorkspace,
  firstDiscoveryMessage,
  handleDiscoveryAnswer,
  normalizeE164,
} from '@/lib/onboarding-whatsapp'
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

      if (agentResult.replyText) {
        const sendResult = await sendFreeFormWhatsApp(
          driverReplyTo,
          agentResult.replyText,
          `driver-${message.id}`
        )
        if (sendResult.status === 'failed') {
          console.error(`[whatsapp-operator] driver reply send failed for ${workspaceId}:`, sendResult.error)
        }
      }
      await persistAgentTurns(supabase, workspaceId, agentResult.newTurns, operator)
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
  // saveBusinessProfile) at the end of the adaptive discovery interview
  // (see lib/onboarding.ts:decideNextDiscoveryStep — grill-me-style, one
  // question at a time, stops as soon as there's enough, capped), so its
  // absence means this workspace hasn't finished onboarding yet. This
  // branch runs even though whatsapp_outbound_enabled is still false —
  // that flag flips true only once discovery completes.
  const replyTo = `+${normalized}`
  if (!cfg.system_prompt) {
    // No turns recorded yet means discovery hasn't actually started —
    // whatever this first message says (however the phone got recognized:
    // cold-start signup, OAuth handoff code, etc.), treat it as "hello,"
    // not as an answer to the first question. onboarding_wa_answers is now
    // an ordered turns array, not a fixed-key map, but Object.keys(...)
    // .length === 0 is equally true for an empty array.
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
        wa_message_id: null,
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

    const { replyText } = await handleDiscoveryAnswer(supabase, workspaceId, answerText, normalized)
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
      operator_allowlist_id: operator.id,
      operator_name: operator.name,
      operator_role: operator.role,
    })
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
        const cayeReply = await generateDemoReply(cfg.system_prompt ?? '', 'your business', history, demoText)
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
      await startDemoSession(supabase, workspaceId, operatorId, replyTo)
      await sendFreeFormWhatsApp(replyTo, DEMO_INTRO_MESSAGE, `demo-start-${message.id}`)
      return
    }
  }

  if (message.type !== 'text' || !message.text?.body) {
    // Non-text — just log and bail. We don't classify media in v1.
    await supabase.from('caye_operator_messages').insert({
      workspace_id: workspaceId,
      direction: 'inbound',
      wa_message_id: message.id,
      body: `[${message.type}]`,
      intent: null,
      operator_allowlist_id: operator.id,
      operator_name: operator.name,
      operator_role: operator.role,
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
      .eq('operator_allowlist_id', operatorId)
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
    operator_allowlist_id: operator.id,
    operator_name: operator.name,
    operator_role: operator.role,
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
        operator_allowlist_id: operator.id,
        operator_name: operator.name,
        operator_role: operator.role,
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
      operatorId,
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
    // the sliding-window loader sees them on the next round. Shared with
    // the web-based Caye Direct route (app/api/founder/caye-direct) so
    // both persist identically.
    await persistAgentTurns(supabase, workspaceId, agentResult.newTurns, operator)
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
        "Let me check on that and get right back to you!"
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
