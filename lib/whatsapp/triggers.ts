import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOutbound } from './outbound'
import { classifyHoldUrgency } from './urgency'
import { inQuietHours, loadScheduleConfig, nextDigestTime } from './schedule'

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
 */
export async function enqueueBookingCreated(input: BookingCreatedInput): Promise<void> {
  const enabled = await operatorPingsEnabled(input.workspaceId)
  if (!enabled) return

  const supabase = createServiceClient()
  const { data: booking } = await supabase
    .from('bookings')
    .select('customer_name, booking_date, booking_time, number_of_people, service:booking_services(name)')
    .eq('id', input.bookingId)
    .maybeSingle()

  if (!booking) return // gone/cancelled before the ping fired — nothing to say

  const serviceRaw = booking.service as { name: string | null } | { name: string | null }[] | null
  const serviceName = (Array.isArray(serviceRaw) ? serviceRaw[0]?.name : serviceRaw?.name) ?? null
  const guest = booking.customer_name ?? 'A guest'
  const summary = formatBookingSummary({
    serviceName,
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time,
    partySize: booking.number_of_people,
  })

  const cfg = await loadScheduleConfig(input.workspaceId)
  const now = new Date()
  const scheduledFor = inQuietHours(now, cfg) ? nextDigestTime(now, cfg) : now

  await enqueueOutbound({
    workspaceId: input.workspaceId,
    kind: 'booking_created',
    conversationId: input.conversationId ?? null,
    payload: { guest, bookingId: input.bookingId, summary },
    scheduledFor,
    idempotencyKey: `booking-${input.bookingId}`,
  })
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
    await enqueueOutbound({
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
        escalationId: input.escalationId,
      },
      // Each recipient gets one row, immediate. Quiet-hours don't apply —
      // escalations carry their own urgency by definition (the customer is
      // already waiting).
      scheduledFor: new Date(),
      idempotencyKey: `${kind}-${input.escalationId}-${recipient.role}-${ts}`,
    })
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
