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
 */
export async function enqueueHoldPing(input: HoldPingInput): Promise<void> {
  const enabled = await operatorPingsEnabled(input.workspaceId)
  if (!enabled) return

  const urgency = input.urgency ?? classifyHoldUrgency({ inboundBody: input.inboundBody })
  const cfg = await loadScheduleConfig(input.workspaceId)
  const now = new Date()

  let scheduledFor: Date
  let kind: 'urgent_hold' | 'morning_digest'

  if (urgency === 'urgent' && !inQuietHours(now, cfg)) {
    scheduledFor = now
    kind = 'urgent_hold'
  } else if (urgency === 'urgent' && inQuietHours(now, cfg)) {
    // Urgent during quiet hours → flush at the start of the digest window (7am).
    scheduledFor = nextDigestTime(now, cfg)
    kind = 'urgent_hold'
  } else {
    // Routine → batch into the morning digest.
    scheduledFor = nextDigestTime(now, cfg)
    kind = 'morning_digest'
  }

  const ts = input.timestamp ?? now.toISOString()

  await enqueueOutbound({
    workspaceId: input.workspaceId,
    kind,
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

export interface SameDayBookingInput {
  workspaceId: string
  conversationId?: string | null
  guest: string
  bookingId: string
}

export async function enqueueSameDayBooking(input: SameDayBookingInput): Promise<void> {
  const enabled = await operatorPingsEnabled(input.workspaceId)
  if (!enabled) return

  const cfg = await loadScheduleConfig(input.workspaceId)
  const now = new Date()
  const scheduledFor = inQuietHours(now, cfg) ? nextDigestTime(now, cfg) : now

  await enqueueOutbound({
    workspaceId: input.workspaceId,
    kind: 'same_day_booking',
    conversationId: input.conversationId ?? null,
    payload: { guest: input.guest, bookingId: input.bookingId },
    scheduledFor,
    idempotencyKey: `sameday-${input.bookingId}`,
  })
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

async function operatorPingsEnabled(workspaceId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('workspace_ai_config')
    .select('whatsapp_outbound_enabled, operator_whatsapp_verified_at')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return Boolean(data?.whatsapp_outbound_enabled && data?.operator_whatsapp_verified_at)
}
