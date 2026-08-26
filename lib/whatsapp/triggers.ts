import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOutbound } from './outbound'
import { classifyHoldUrgency } from './urgency'
import { inQuietHours, loadScheduleConfig, nextDigestTime } from './schedule'
import { markAttentionPending, SUBJECT_CONVERSATION } from '@/lib/owner-attention'
import { decideOperatorNotification } from './operator-notification-gate'

/**
 * Trigger sites in the five webhook handlers call enqueueHoldPing() right
 * after they set human_agent_enabled=true. This file owns the
 * "should we ping now? batch? skip?" decision so the webhook handlers stay
 * thin.
 *
 * Same applies to enqueueAuthFailurePing() — call from error paths where
 * Zoho / Meta tokens have expired.
 */

export interface HoldPingInput {
  workspaceId: string
  conversationId: string
  contactName: string
  reason: string
  proposedReply?: string
  inboundBody: string
  /** Optional: caller may have already classified urgency. */
  urgency?: 'urgent' | 'routine'
  /** Per-conversation timestamp used to make the idempotency key unique. */
  timestamp?: string
}

/**
 * A reply was already sent but merits a quick operator review. This creates
 * neither an escalation nor an attention item: the customer is not waiting
 * on a human, so a "needs your call" brief and reminder cadence are wrong.
 */
export async function enqueueReplyReviewPing(input: {
  workspaceId: string
  conversationId: string
  contactName: string
  note: string
}): Promise<void> {
  const enabled = await operatorPingsEnabled(input.workspaceId)
  if (!enabled) return

  const recipients = await resolveEscalationRecipients(input.workspaceId, 'owner')
  const body = `${input.note.trim()}\n\n${input.contactName}'s reply has already gone out.`
  for (const recipient of recipients) {
    await enqueueOutbound({
      workspaceId: input.workspaceId,
      kind: 'reply_review',
      conversationId: input.conversationId,
      payload: {
        to_phone: recipient.phone,
        recipient_role: recipient.role,
        body,
        contactName: input.contactName,
      },
      scheduledFor: new Date(),
      idempotencyKey: `reply-review-${input.conversationId}-${recipient.role}`,
    })
  }
}

/**
 * Decide whether to enqueue + at what time. No-op when the workspace flag is
 * off or the operator number isn't verified — both checked up-front to avoid
 * landing dead rows in the queue.
 *
 * Every hold pings the owner in real time, regardless of urgency — locked
 * 2026-07-26 after Karenda (Bimini) reported Caye going silent on holds she
 * only discovered by asking. Caye had told her directly "I'll call out held
 * items as they come in"; routine holds staying silent until the next
 * digest broke that promise every time. Routine (non-urgent) holds used to
 * be filtered out here on the theory that they'd already show up in the
 * next morning digest's live heldCount query
 * (app/api/caye/morning-digest/route.ts) — true in principle, but the
 * digest was separately confirmed broken for days at a time (see
 * owner-trust-pipeline-spec.md), so "it's in tomorrow's digest" meant "it
 * may never surface." Quiet hours still defer to the next digest window —
 * this only removes the routine/urgent split, not the quiet-hours handling
 * below.
 */
export async function enqueueHoldPing(input: HoldPingInput): Promise<void> {
  const enabled = await operatorPingsEnabled(input.workspaceId)
  if (!enabled) return

  const urgency = input.urgency ?? classifyHoldUrgency({ inboundBody: input.inboundBody })

  const cfg = await loadScheduleConfig(input.workspaceId)
  const now = new Date()

  const scheduledFor = inQuietHours(now, cfg)
    ? nextDigestTime(now, cfg) // Urgent during quiet hours → flush at the start of the digest window (7am).
    : now

  const ts = input.timestamp ?? now.toISOString()

  await enqueueOutbound({
    workspaceId: input.workspaceId,
    kind: 'urgent_hold',
    conversationId: input.conversationId,
    payload: {
      contactName: input.contactName,
      reason: input.reason,
      proposedReply: input.proposedReply ?? null,
      inboundBody: input.inboundBody.slice(0, 500),
      urgency,
    },
    scheduledFor,
    idempotencyKey: `hold-${input.conversationId}-${ts}`,
  })
}

export interface BookingCreatedInput {
  workspaceId: string
  conversationId?: string | null
  bookingId: string
}

/**
 * Ping the owner whenever Caye creates a booking, any date — not just
 * same-day (this replaces enqueueSameDayBooking, which existed but was
 * never actually called anywhere in the codebase; same-day-only was the
 * plan, but "no ping until it's today" left every future-dated booking
 * silent, which is exactly what Karenda flagged: "there were bookings" as
 * evidence Caye had gone quiet). Locked 2026-07-26 — bookings are revenue
 * events; the owner should hear about them immediately regardless of when
 * the tour itself happens.
 *
 * Fetches the booking's own details rather than requiring the caller to
 * pass them through — every call site already has bookingId from
 * decision.bookingId and nothing else, so resolving details here keeps
 * every call site a one-liner.
 *
 * WHY THIS ROUTES THROUGH decideOperatorNotification (2026-08-26, Autumn
 * McNeill incident). This used to enqueue unconditionally, with no
 * awareness of the caye_owner_attention ledger at all — it was the one
 * proactive producer in the codebase that never asked "does the operator
 * already know this." Real production trace: Mrs. Max personally drafted,
 * edited, and sent Autumn's reply through Caye, then told Caye directly she
 * had. A "Just booked — Autumn McNeill..." ping still fired ~9.5h later
 * (quiet-hours deferred it), because nothing here had ever checked. Now it
 * observes the same ledger every other producer uses and, when a
 * conversation is linked, asks the shared operatorParticipationCheck
 * whether the operator was already structurally proven to be in that exact
 * conversation — see lib/whatsapp/operator-participation.ts.
 */
export async function enqueueBookingCreated(input: BookingCreatedInput): Promise<void> {
  const enabled = await operatorPingsEnabled(input.workspaceId)
  if (!enabled) return

  const supabase = createServiceClient()
  const { data: booking } = await supabase
    .from('bookings')
    .select(
      'conversation_id, customer_name, booking_date, booking_time, number_of_people, status, payment_confirmed_at, payment_link_sent_at, cancelled_at, created_at, updated_at, service:booking_services(name)'
    )
    .eq('id', input.bookingId)
    .maybeSingle()

  if (!booking) return // gone/cancelled before the ping fired — nothing to say

  const serviceRaw = booking.service as { name: string | null } | { name: string | null }[] | null
  const serviceName = (Array.isArray(serviceRaw) ? serviceRaw[0]?.name : serviceRaw?.name) ?? null
  const guest = booking.customer_name ?? 'A guest'
  const stateLabel = bookingStateLabel(booking.status, booking.payment_confirmed_at)
  const summary = formatBookingSummary({
    serviceName,
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time,
    partySize: booking.number_of_people,
  })

  // bookings.conversation_id is the authoritative link — prefer it over the
  // caller-supplied conversationId (every call site resolves its own
  // conversation slightly differently; the booking row's own reference is
  // the one thing every path agrees on).
  const conversationId = booking.conversation_id ?? input.conversationId ?? null

  const decision = await decideOperatorNotification({
    workspaceId: input.workspaceId,
    subjectType: 'booking',
    subjectId: input.bookingId,
    conversationId,
    title: `${guest} — ${stateLabel}`,
    priority: 'awareness',
    // The fields that actually define what's being reported — a status
    // flip or a payment event re-earns a ping; the row's own churn
    // (updated_at bumping for unrelated reasons) does not.
    fingerprintParts: [
      booking.status,
      booking.payment_confirmed_at,
      booking.payment_link_sent_at,
      booking.cancelled_at,
      booking.booking_date,
      booking.booking_time,
      booking.number_of_people,
    ],
    blockedOnOperator: false,
    resolvableAutonomously: false,
    ...(conversationId
      ? {
          operatorParticipationCheck: {
            conversationId,
            stateSinceISO: booking.updated_at ?? booking.created_at,
          },
        }
      : {}),
  })

  if (decision.outcome !== 'SEND_NEW' && decision.outcome !== 'SEND_REMINDER' && decision.outcome !== 'SEND_CRITICAL_ESCALATION') {
    // SUPPRESS_OPERATOR_AWARE (operator already handled this conversation
    // directly), SUPPRESS_NO_CHANGE / SUPPRESS_RECENTLY_NOTIFIED (already
    // told, nothing new), or RESOLVED_NO_NOTIFICATION — none of these
    // warrant a ping. The item was still observed above, so a genuinely
    // later material change (a real status/payment transition) re-earns a
    // real notification on its own next time this fires.
    return
  }

  const cfg = await loadScheduleConfig(input.workspaceId)
  const now = new Date()
  const scheduledFor = inQuietHours(now, cfg) ? nextDigestTime(now, cfg) : now

  const queued = await enqueueOutbound({
    workspaceId: input.workspaceId,
    kind: 'booking_created',
    conversationId,
    payload: { guest, bookingId: input.bookingId, summary, stateLabel },
    scheduledFor,
    idempotencyKey: `booking-${input.bookingId}`,
  })

  if (queued) {
    await markAttentionPending({
      workspaceId: input.workspaceId,
      subjectType: 'booking',
      subjectId: input.bookingId,
      queueId: queued.id,
    })
  }
}

/**
 * Honest, ground-truth booking state language — never "Just booked" for a
 * booking nobody has paid for. Mirrors the real booking_status Postgres
 * enum (pending/confirmed/cancelled — see `enum_range(null::booking_status)`)
 * plus payment_confirmed_at, which the enum alone doesn't capture. A native
 * enum type, not a CHECK constraint, so lib/db/check-constraints.ts's guard
 * doesn't cover it — if the enum ever grows a value, this needs a manual
 * update too.
 */
function bookingStateLabel(status: string, paymentConfirmedAt: string | null): string {
  if (status === 'cancelled') return 'Booking cancelled'
  if (paymentConfirmedAt) return 'Booking confirmed & paid'
  if (status === 'confirmed') return 'Booking confirmed'
  return 'New pending booking'
}

function formatBookingSummary(args: {
  serviceName: string | null
  bookingDate: string
  bookingTime: string | null
  partySize: number | null
}): string {
  const dateLabel = new Date(`${args.bookingDate}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
  const timeLabel = args.bookingTime ? ` at ${args.bookingTime.slice(0, 5)}` : ''
  const partyLabel = args.partySize ? `, ${args.partySize} ${args.partySize === 1 ? 'guest' : 'guests'}` : ''
  return `${args.serviceName ?? 'a tour'} on ${dateLabel}${timeLabel}${partyLabel}`
}

export interface AuthFailureInput {
  workspaceId: string
  service: 'Zoho Mail' | 'Zoho Calendar' | 'Gmail' | 'WhatsApp' | 'Instagram' | 'Messenger'
  reconnectUrl?: string
}

/**
 * Auth failures bypass quiet hours and mute (see worker MUTE_BYPASS_KINDS).
 * Idempotency: one ping per workspace + service + day, so a flapping
 * connection doesn't spam.
 */
export async function enqueueAuthFailurePing(input: AuthFailureInput): Promise<void> {
  const enabled = await operatorPingsEnabled(input.workspaceId)
  if (!enabled) return

  const dayKey = new Date().toISOString().slice(0, 10)
  await enqueueOutbound({
    workspaceId: input.workspaceId,
    kind: 'auth_failure',
    payload: {
      service: input.service,
      reconnectUrl: input.reconnectUrl ?? '',
    },
    scheduledFor: new Date(),
    idempotencyKey: `auth-failure-${input.workspaceId}-${input.service}-${dayKey}`,
  })
}

export interface EscalationPingInput {
  workspaceId: string
  escalationId: string
  conversationId: string | null
  contactName: string
  /** 'gap' | 'policy' | 'knowledge' | 'sensitive' — surfaced in the operator
   *  ping so the recipient knows whether this needs a tool fix (founder) or a
   *  policy/knowledge call (owner) before they even open the thread. */
  category: string
  /** 'owner' | 'founder' | 'both'. The trigger resolves this into one queue
   *  row per recipient phone — 'both' fans out to two rows. */
  routeTo: 'owner' | 'founder' | 'both'
  /** Caye's suggested reply to the customer — shows up in the operator ping
   *  as the starting draft, same shape as the existing hold flow's
   *  proposed_reply. */
  suggestedReply: string
  /** Short summary of the customer ask + Caye's reasoning. */
  internalContext: string
  /** Operator-friendly one-liner for the WhatsApp ping (~80-100 chars). Goes
   *  into the caye_urgent_hold template's reason placeholder so the operator
   *  sees a readable summary instead of truncated dev-debug text. */
  pingSummary?: string
  /** Composed operator brief (lib/operator-brief.ts) — full multi-line
   *  message. Sent free-form when the recipient's WhatsApp window is open;
   *  ignored (falls back to oneLine/pingSummary) when it's closed, since
   *  Meta template params can't carry newlines. */
  brief?: string
  /** Template-safe one-line summary from buildOperatorBrief — preferred
   *  over pingSummary for the template placeholder when present, since it
   *  actually names the booking/ask instead of raw form-field syntax. */
  oneLine?: string
  /** Used to make the idempotency key unique across retries on the same
   *  escalation row. */
  timestamp?: string
}

/**
 * Fan out an escalation to the right operator phones. owner pings go through
 * the existing override-aware path (operator_notification_override_phone for
 * shadow routing); founder pings go straight to the founder phone on the
 * operator_allowlist for that workspace (no override — the founder always
 * sees their own pings).
 *
 * No-op when the workspace flag is off or no recipient phones are found.
 */
export async function enqueueEscalationPings(
  input: EscalationPingInput,
  kind: 'escalation' | 'escalation_followup' = 'escalation'
): Promise<void> {
  const enabled = await operatorPingsEnabled(input.workspaceId)
  if (!enabled) return

  const recipients = await resolveEscalationRecipients(input.workspaceId, input.routeTo)
  if (recipients.length === 0) return

  // Bucketed to the hour, not the raw timestamp: keeps the idempotency key
  // distinct across genuinely separate sends (the daily follow-up cron is
  // ~24h apart) while collapsing retries/overlapping invocations of the
  // *same* cron run (seconds apart) onto one key, so enqueueOutbound's
  // unique constraint actually catches the duplicate instead of both firing.
  const rawTs = input.timestamp ?? new Date().toISOString()
  const ts = new Date(
    Math.floor(new Date(rawTs).getTime() / (60 * 60 * 1000)) * 60 * 60 * 1000
  ).toISOString()

  // One queue row per recipient phone. Each carries the destination phone in
  // payload so the dispatch doesn't need to re-resolve the route_to + override
  // logic; it just sends to payload.to_phone.
  for (const recipient of recipients) {
    const queued = await enqueueOutbound({
      workspaceId: input.workspaceId,
      kind,
      conversationId: input.conversationId,
      payload: {
        to_phone: recipient.phone,
        recipient_role: recipient.role,
        contactName: input.contactName,
        category: input.category,
        suggestedReply: input.suggestedReply.slice(0, 800),
        internalContext: input.internalContext.slice(0, 800),
        // ping_summary is the operator-friendly text the outbound worker
        // drops into the caye_urgent_hold template's reason placeholder.
        // Falls back inside the worker if absent.
        ping_summary: input.pingSummary?.slice(0, 120),
        // brief: full multi-line handoff, sent free-form when this
        // recipient's window is open. one_line: the template-safe
        // fallback, preferred over ping_summary when present.
        brief: input.brief,
        one_line: input.oneLine?.slice(0, 160),
        escalationId: input.escalationId,
      },
      // Each recipient gets one row, immediate. Quiet-hours don't apply —
      // escalations carry their own urgency by definition (the customer is
      // already waiting).
      scheduledFor: new Date(),
      idempotencyKey: `${kind}-${input.escalationId}-${recipient.role}-${ts}`,
    })

    // Mark "notification in flight" the instant it's queued, not once it's
    // actually sent (2026-08-13) — closes the gap where the morning digest
    // composes before the outbound worker's next ~30s tick has dispatched
    // this row, and would otherwise see notify_count=0 and independently
    // narrate Karin as unreported while a ping for her is already on the
    // way. Owner-recipient only: the owner's ping is what a composer like
    // the digest cares about; a founder backstop row is a separate concern
    // with its own dedup (founder_escalated_at). Same subject-key
    // derivation recordEscalation used to register this item — see
    // escalation.ts. A no-op update when no matching row exists (e.g. the
    // driver-question caller, whose attention item lives under a different
    // subject_type entirely) is harmless by construction.
    if (queued && recipient.role === 'owner') {
      await markAttentionPending({
        workspaceId: input.workspaceId,
        subjectType: input.conversationId ? SUBJECT_CONVERSATION : 'escalation',
        subjectId: input.conversationId ?? input.escalationId,
        queueId: queued.id,
      })
    }
  }
}

interface EscalationRecipient {
  phone: string
  role: 'owner' | 'founder'
}

export async function resolveEscalationRecipients(
  workspaceId: string,
  routeTo: 'owner' | 'founder' | 'both'
): Promise<EscalationRecipient[]> {
  const supabase = createServiceClient()
  const out: EscalationRecipient[] = []

  if (routeTo === 'owner' || routeTo === 'both') {
    const { data: cfg } = await supabase
      .from('workspace_ai_config')
      .select('operator_whatsapp_number, operator_notification_override_phone')
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    const ownerPhone =
      cfg?.operator_notification_override_phone ?? cfg?.operator_whatsapp_number ?? null
    if (ownerPhone) out.push({ phone: ownerPhone, role: 'owner' })
  }

  if (routeTo === 'founder' || routeTo === 'both') {
    const { data: rows } = await supabase
      .from('operator_allowlist')
      .select('phone')
      .eq('workspace_id', workspaceId)
      .eq('role', 'founder')
      .limit(1)
    const founderPhone = rows?.[0]?.phone ?? null
    if (founderPhone) out.push({ phone: founderPhone, role: 'founder' })
  }

  return out
}

export async function operatorPingsEnabled(workspaceId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('workspace_ai_config')
    .select('whatsapp_outbound_enabled, operator_whatsapp_verified_at')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return Boolean(data?.whatsapp_outbound_enabled && data?.operator_whatsapp_verified_at)
}
