import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import {
  observeAttentionItem,
  markAttentionNotified,
  recordOperatorAwareness,
  setAttentionStatus,
  type AttentionPriority,
} from '@/lib/owner-attention'
import { hasOperatorParticipatedInConversation } from './operator-participation'

/**
 * Shared gate every autonomous producer (escalations, opportunity-scan,
 * business-insights, driver questions, ...) calls before sending an
 * operator-facing WhatsApp message. Built entirely on the existing
 * caye_owner_attention ledger (lib/owner-attention.ts) — this is not a
 * parallel dedupe system, it's the policy layer that decides what to DO
 * with what that ledger already knows.
 *
 * THE QUESTION THIS ANSWERS, ALWAYS: does the operator need to know or do
 * something NEW? Never: did some subsystem produce an event? A scan running,
 * a cron firing, an escalation row existing — none of those are reasons to
 * send on their own. Only a genuinely new item, a material change to one
 * already told, or a caller-declared urgency escalation is.
 */

export type NotificationOutcome =
  | 'SEND_NEW'
  | 'SEND_REMINDER'
  | 'SEND_CRITICAL_ESCALATION'
  | 'RESOLVED_NO_NOTIFICATION'
  | 'SUPPRESS_NO_CHANGE'
  | 'SUPPRESS_RECENTLY_NOTIFIED'
  /** The operator already demonstrated awareness of this EXACT current
   *  state themselves (structural evidence, not inference) — Caye never
   *  said anything and doesn't need to. See operatorParticipationCheck. */
  | 'SUPPRESS_OPERATOR_AWARE'

export interface NotificationDecision {
  outcome: NotificationOutcome
  attentionItemId: string | null
  /** True on SEND_NEW when this is a re-notification of an item already
   *  told about before (fingerprint changed) — callers use this to compose
   *  "what changed" instead of the full original context, per the brief's
   *  "don't regenerate the incident report" rule. */
  isMaterialChange: boolean
}

export interface DecideNotificationInput {
  workspaceId: string
  subjectType: string
  subjectId: string
  conversationId?: string | null
  title: string
  priority: AttentionPriority
  nextAction?: string | null
  /** Fields whose change should re-earn the operator's attention — the ask,
   *  the date, the amount, the status. NOT the clock. */
  fingerprintParts: unknown[]
  /** Is Caye actually waiting on the operator right now. Default true. */
  blockedOnOperator?: boolean
  /** Could Caye finish this herself given her current tools. Default false.
   *  true + !blockedOnOperator resolves the item instead of pinging —
   *  rising autonomy should shrink the operator's queue, not just narrate
   *  it (brief §9). */
  resolvableAutonomously?: boolean
  /** Escalations and urgent holds carry their own urgency by construction
   *  (a customer is already waiting) and must never be throttled by the
   *  low-priority cooldown below — only proactive, self-initiated findings
   *  (scans, insights) are subject to it. Default false. */
  bypassCooldown?: boolean
  /** Opt-in structural awareness check: does live evidence show the
   *  operator already personally participated in this exact conversation
   *  around the time the reported state came to be? When provided and a
   *  match is found, the gate suppresses as SUPPRESS_OPERATOR_AWARE instead
   *  of sending — Caye already has proof the operator knows, independent of
   *  whether she ever told them.
   *
   *  Opt-in, not automatic for every caller with a conversationId — this is
   *  a real behavior change (a subject can now go straight from "never
   *  observed" to "suppressed" with zero notifications), and existing
   *  callers (escalations, opportunity-scan) keep their current behavior
   *  unchanged unless they explicitly ask for this. Never applied to
   *  'critical' priority — a customer-blocking item stays conservative even
   *  against strong participation evidence (design constraint: false
   *  suppression is worse than one redundant critical ping). */
  operatorParticipationCheck?: { conversationId: string; stateSinceISO: string }
}

// Reminder cadence — a human pace, not a monitoring system's. The goal is
// never "nag because time passed"; it's "the operator hasn't had a fair
// chance to see this and it still matters." A material change (checked
// before any of these thresholds even get consulted) always bypasses them.
const CRITICAL_REMINDER_MS = 1.5 * 60 * 60 * 1000 // ~1-2h: immediate customer/revenue risk
const DECISION_BLOCKING_REMINDER_MS = 5 * 60 * 60 * 1000 // ~4-6h: Caye is genuinely stuck on this
const DECISION_ORDINARY_REMINDER_MS = 8 * 60 * 60 * 1000 // later that day / next working period: real but not blocking
// awareness/routine: no automatic reminder at all — surfaces once, and any
// later mention is the next digest's call, not a repeat ping from this gate.

function reminderThresholdMs(priority: AttentionPriority, blockedOnOperator: boolean): number | null {
  if (priority === 'critical') return CRITICAL_REMINDER_MS
  if (priority === 'decision') return blockedOnOperator ? DECISION_BLOCKING_REMINDER_MS : DECISION_ORDINARY_REMINDER_MS
  return null
}

// "Several low-priority things happen" (brief §5) shouldn't each earn their
// own ping just because a different job noticed them minutes apart — but
// this must never touch anything urgent. Scoped to awareness/routine only.
const LOW_PRIORITY_COOLDOWN_MS = 15 * 60 * 1000
const COOLDOWN_PRIORITIES = new Set<AttentionPriority>(['awareness', 'routine'])

// Read receipts inform pacing but must never make a reminder fire FASTER —
// "I saw you read it" pressure is exactly what this product is not. The
// only effect allowed here is lengthening: read-but-unanswered-and-not-
// blocking earns a little more patience, never less.
const READ_UNANSWERED_PATIENCE_MULTIPLIER = 1.5

export async function decideOperatorNotification(
  input: DecideNotificationInput
): Promise<NotificationDecision> {
  const blockedOnOperator = input.blockedOnOperator ?? true
  const resolvableAutonomously = input.resolvableAutonomously ?? false

  const item = await observeAttentionItem({
    workspaceId: input.workspaceId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    conversationId: input.conversationId ?? null,
    title: input.title,
    priority: input.priority,
    nextAction: input.nextAction ?? null,
    fingerprintParts: input.fingerprintParts,
    blockedOnOperator,
    resolvableAutonomously,
  })

  if (!item) {
    // Bookkeeping failed. Fail toward telling the operator rather than
    // silently dropping something they may genuinely need — but this must
    // never throw or block the caller either way.
    return { outcome: 'SEND_NEW', attentionItemId: null, isMaterialChange: false }
  }

  // Rising autonomy resolves the item instead of narrating it (brief §9):
  // once Caye can actually finish this herself, it stops being the
  // operator's problem, and the gate reflects that immediately rather than
  // waiting for one more round of "still open."
  if (resolvableAutonomously && !blockedOnOperator && item.status !== 'resolved' && item.status !== 'dismissed') {
    await setAttentionStatus({
      workspaceId: input.workspaceId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      status: 'resolved',
    })
    return { outcome: 'RESOLVED_NO_NOTIFICATION', attentionItemId: item.id, isMaterialChange: false }
  }

  if (item.status === 'resolved' || item.status === 'dismissed') {
    return { outcome: 'RESOLVED_NO_NOTIFICATION', attentionItemId: item.id, isMaterialChange: false }
  }

  // Structural operator-awareness check — evaluated fresh every call (not
  // cached), so a re-check after a material change correctly asks "did the
  // operator participate around THIS state" rather than trusting a stale
  // answer. Skipped for 'critical': a customer-blocking item stays on the
  // conservative path even against strong participation evidence.
  if (input.operatorParticipationCheck && input.priority !== 'critical') {
    const participated = await hasOperatorParticipatedInConversation(
      input.operatorParticipationCheck.conversationId,
      input.operatorParticipationCheck.stateSinceISO
    )
    if (participated) {
      if (item.operatorAwareFingerprint !== item.stateFingerprint) {
        await recordOperatorAwareness({
          workspaceId: input.workspaceId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          evidence: 'Operator sent a customer-facing reply in this conversation themselves.',
        })
      }
      return { outcome: 'SUPPRESS_OPERATOR_AWARE', attentionItemId: item.id, isMaterialChange: false }
    }
  }

  const changed = item.stateFingerprint !== item.notifiedFingerprint
  const isNew = item.notifyCount === 0

  if (isNew) {
    if (await underCooldown(input.workspaceId, input.priority, input.bypassCooldown)) {
      return { outcome: 'SUPPRESS_RECENTLY_NOTIFIED', attentionItemId: item.id, isMaterialChange: false }
    }
    return {
      outcome: input.priority === 'critical' ? 'SEND_CRITICAL_ESCALATION' : 'SEND_NEW',
      attentionItemId: item.id,
      isMaterialChange: false,
    }
  }

  // A material change bypasses the reminder interval entirely — this is
  // what lets Karin's second, more frustrated follow-up surface immediately
  // even 20 minutes after a "stay quiet" verdict, while "still unresolved"
  // alone never does.
  if (changed) {
    if (await underCooldown(input.workspaceId, input.priority, input.bypassCooldown)) {
      return { outcome: 'SUPPRESS_RECENTLY_NOTIFIED', attentionItemId: item.id, isMaterialChange: true }
    }
    return {
      outcome: input.priority === 'critical' ? 'SEND_CRITICAL_ESCALATION' : 'SEND_NEW',
      attentionItemId: item.id,
      isMaterialChange: true,
    }
  }

  // Nothing changed. An operator who has already responded (acknowledged)
  // stays un-reminded regardless of elapsed time — only a material change
  // or a caller-declared urgency bump reopens it. This is what stops "read
  // it, replied about something else entirely, still got nagged an hour
  // later" — see lib/whatsapp/attention-acknowledgement.ts for how an item
  // gets here.
  if (item.status === 'acknowledged') {
    return { outcome: 'SUPPRESS_NO_CHANGE', attentionItemId: item.id, isMaterialChange: false }
  }

  const threshold = reminderThresholdMs(input.priority, blockedOnOperator)
  // threshold === null means the priority tier itself never auto-reminds
  // (awareness/routine). blockedOnOperator has no separate veto here —
  // reminderThresholdMs already picked the right (longer) cadence for a
  // non-blocking decision item; silencing it again on top of that would
  // mean an "ordinary action needed" item never reminds at all, which is
  // not what "later today / next working period" means.
  if (threshold === null) {
    return { outcome: 'SUPPRESS_NO_CHANGE', attentionItemId: item.id, isMaterialChange: false }
  }

  const elapsed = item.lastNotifiedAt ? Date.now() - new Date(item.lastNotifiedAt).getTime() : Infinity
  const effectiveThreshold = await lengthenIfReadUnanswered(item, threshold)
  if (elapsed < effectiveThreshold) {
    return { outcome: 'SUPPRESS_RECENTLY_NOTIFIED', attentionItemId: item.id, isMaterialChange: false }
  }

  return { outcome: 'SEND_REMINDER', attentionItemId: item.id, isMaterialChange: false }
}

/** Stamp that the operator was just told, for callers that sent a SEND_*
 *  outcome. Thin pass-through to markAttentionNotified — kept here so every
 *  caller goes through one module for the full decide→send→record cycle. */
export async function recordOperatorNotified(args: {
  workspaceId: string
  subjectType: string
  subjectId: string
  summary: string
  queueId?: string
}): Promise<void> {
  await markAttentionNotified(args)
}

async function underCooldown(
  workspaceId: string,
  priority: AttentionPriority,
  bypass: boolean | undefined
): Promise<boolean> {
  if (bypass || !COOLDOWN_PRIORITIES.has(priority)) return false
  try {
    const supabase = createServiceClient()
    const since = new Date(Date.now() - LOW_PRIORITY_COOLDOWN_MS).toISOString()
    const { data } = await supabase
      .from('caye_operator_messages')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('direction', 'outbound')
      .gte('created_at', since)
      .limit(1)
    return Boolean(data && data.length > 0)
  } catch (err) {
    console.error('[operator-notification-gate] cooldown check failed:', err)
    return false
  }
}

/** Read receipts only ever make the gate MORE patient, never less — this is
 *  the one place wa_delivery_status is consulted, and it can only push the
 *  threshold up, never down. A read-but-unanswered non-blocking item earns
 *  extra slack on the theory that the operator saw it and made a call to
 *  come back to it later; a blocking item is left at its normal threshold
 *  either way, since Caye genuinely can't move without them regardless of
 *  what the read receipt implies about their intentions. */
async function lengthenIfReadUnanswered(
  item: { lastNotificationQueueId: string | null; blockedOnOperator: boolean },
  baseThresholdMs: number
): Promise<number> {
  if (!item.lastNotificationQueueId || item.blockedOnOperator) return baseThresholdMs
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from('caye_outbound_queue')
      .select('wa_delivery_status')
      .eq('id', item.lastNotificationQueueId)
      .maybeSingle()
    if (data?.wa_delivery_status === 'read') {
      return baseThresholdMs * READ_UNANSWERED_PATIENCE_MULTIPLIER
    }
  } catch (err) {
    console.error('[operator-notification-gate] read-receipt check failed:', err)
  }
  return baseThresholdMs
}
