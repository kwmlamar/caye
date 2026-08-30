import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import {
  observeAttentionItem,
  markAttentionNotified,
  recordOperatorAwareness,
  setAttentionStatus,
  type AttentionPriority,
} from '@/lib/owner-attention'
import {
  evaluateInterruption,
  type AwarenessState,
  type ChangeKind,
  type ConfidenceLevel,
  type InterruptionLevel,
  type InterruptionPolicyDecision,
} from '@/lib/interruption-policy'
import { hasOperatorParticipatedInConversation, type ParticipationEvidenceMode } from './operator-participation'

/** Shared operator-facing notification choke point. Durable attention state
 * remains in caye_owner_attention; this module adds deterministic policy on
 * top of it instead of creating another notification or dedupe system. */
export type NotificationOutcome =
  | 'SEND_NEW'
  | 'SEND_REMINDER'
  | 'SEND_CRITICAL_ESCALATION'
  | 'RESOLVED_NO_NOTIFICATION'
  | 'SUPPRESS_NO_CHANGE'
  | 'SUPPRESS_RECENTLY_NOTIFIED'
  | 'SUPPRESS_OPERATOR_AWARE'

export interface NotificationDecision {
  outcome: NotificationOutcome
  attentionItemId: string | null
  isMaterialChange: boolean
  interruptionPolicy?: InterruptionPolicyDecision
}

export interface DecideNotificationInput {
  workspaceId: string
  subjectType: string
  subjectId: string
  conversationId?: string | null
  title: string
  priority: AttentionPriority
  nextAction?: string | null
  fingerprintParts: unknown[]
  blockedOnOperator?: boolean
  resolvableAutonomously?: boolean
  bypassCooldown?: boolean
  operatorParticipationCheck?: { conversationId: string }

  /** Independent policy dimensions. Legacy priority-derived values remain the
   * compatibility fallback so current producers do not need a flag day. */
  urgency?: InterruptionLevel
  importance?: InterruptionLevel
  confidence?: ConfidenceLevel
  materialChangeKind?: Extract<ChangeKind, 'improved' | 'worsened' | 'changed'>
  consequencesOfWaiting?: InterruptionLevel
  /** Capability is not permission. Existing callers historically treated
   * resolvableAutonomously as already-authorized, so default true preserves
   * behavior until a caller passes the separated authority result. */
  authorityAllowsAutonomousAction?: boolean
}

const CRITICAL_REMINDER_MS = 1.5 * 60 * 60 * 1000
const DECISION_BLOCKING_REMINDER_MS = 5 * 60 * 60 * 1000
const DECISION_ORDINARY_REMINDER_MS = 8 * 60 * 60 * 1000
const LOW_PRIORITY_COOLDOWN_MS = 15 * 60 * 1000
const DAILY_INTERRUPTION_BUDGET = 3
const COOLDOWN_PRIORITIES = new Set<AttentionPriority>(['awareness', 'routine'])
const BUDGET_PRIORITIES = new Set<AttentionPriority>(['awareness', 'routine'])
const READ_UNANSWERED_PATIENCE_MULTIPLIER = 1.5

function reminderThresholdMs(priority: AttentionPriority, blockedOnOperator: boolean): number | null {
  if (priority === 'critical') return CRITICAL_REMINDER_MS
  if (priority === 'decision') return blockedOnOperator ? DECISION_BLOCKING_REMINDER_MS : DECISION_ORDINARY_REMINDER_MS
  return null
}

function priorityDimensions(priority: AttentionPriority): { urgency: InterruptionLevel; importance: InterruptionLevel } {
  switch (priority) {
    case 'critical': return { urgency: 'critical', importance: 'critical' }
    case 'decision': return { urgency: 'high', importance: 'high' }
    case 'awareness': return { urgency: 'medium', importance: 'medium' }
    default: return { urgency: 'low', importance: 'low' }
  }
}

function awarenessFor(item: { status: string; notifyCount: number }): AwarenessState {
  if (item.status === 'resolved' || item.status === 'dismissed') return 'resolved'
  if (item.status === 'acknowledged' || item.status === 'decided') return 'acknowledged'
  return item.notifyCount > 0 ? 'surfaced' : 'unseen'
}

interface PolicyAuditDimensions {
  urgency: InterruptionLevel
  importance: InterruptionLevel
  confidence: ConfidenceLevel
  changeKind: ChangeKind
  awareness: AwarenessState
  blockedOnOperator: boolean
  resolvableAutonomously: boolean
  authorityAllowsAutonomousAction: boolean
  cooldownActive: boolean
  interruptionBudgetExhausted: boolean
  consequencesOfWaiting?: InterruptionLevel
}

async function recordPolicyDecision(
  attentionItemId: string,
  decision: InterruptionPolicyDecision,
  dimensions: PolicyAuditDimensions
): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('caye_owner_attention')
      .update({
        last_policy_decision: { ...decision, dimensions },
        last_policy_decided_at: new Date().toISOString(),
      })
      .eq('id', attentionItemId)
    if (error) console.error('[operator-notification-gate] policy audit failed:', error)
  } catch (err) {
    // Audit bookkeeping must never suppress a real operator notification.
    console.error('[operator-notification-gate] policy audit failed:', err)
  }
}

async function policyFor(args: {
  input: DecideNotificationInput
  item: { id: string; status: string; notifyCount: number }
  changeKind: ChangeKind
  blockedOnOperator: boolean
  resolvableAutonomously: boolean
  cooldownActive: boolean
  budgetExhausted: boolean
}): Promise<InterruptionPolicyDecision> {
  const defaults = priorityDimensions(args.input.priority)
  const dimensions: PolicyAuditDimensions = {
    urgency: args.input.urgency ?? defaults.urgency,
    importance: args.input.importance ?? defaults.importance,
    confidence: args.input.confidence ?? 'high',
    changeKind: args.changeKind,
    awareness: awarenessFor(args.item),
    blockedOnOperator: args.blockedOnOperator,
    resolvableAutonomously: args.resolvableAutonomously,
    authorityAllowsAutonomousAction: args.input.authorityAllowsAutonomousAction ?? true,
    cooldownActive: args.cooldownActive,
    interruptionBudgetExhausted: args.budgetExhausted,
    ...(args.input.consequencesOfWaiting ? { consequencesOfWaiting: args.input.consequencesOfWaiting } : {}),
  }
  const decision = evaluateInterruption({
    workspaceId: args.input.workspaceId,
    subjectType: args.input.subjectType,
    subjectId: args.input.subjectId,
    ...dimensions,
  })
  await recordPolicyDecision(args.item.id, decision, dimensions)
  return decision
}

export async function decideOperatorNotification(input: DecideNotificationInput): Promise<NotificationDecision> {
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

  if (!item) return { outcome: 'SEND_NEW', attentionItemId: null, isMaterialChange: false }

  if (item.status === 'resolved' || item.status === 'dismissed') {
    const policy = await policyFor({ input, item, changeKind: 'resolved', blockedOnOperator, resolvableAutonomously, cooldownActive: false, budgetExhausted: false })
    return { outcome: 'RESOLVED_NO_NOTIFICATION', attentionItemId: item.id, isMaterialChange: false, interruptionPolicy: policy }
  }

  if (resolvableAutonomously && !blockedOnOperator) {
    const policy = await policyFor({ input, item, changeKind: 'unchanged', blockedOnOperator, resolvableAutonomously, cooldownActive: false, budgetExhausted: false })
    if (policy.action === 'HANDLE_AUTONOMOUSLY') {
      await setAttentionStatus({ workspaceId: input.workspaceId, subjectType: input.subjectType, subjectId: input.subjectId, status: 'resolved' })
      return { outcome: 'RESOLVED_NO_NOTIFICATION', attentionItemId: item.id, isMaterialChange: false, interruptionPolicy: policy }
    }
  }

  if (input.operatorParticipationCheck && input.priority !== 'critical') {
    const mode: ParticipationEvidenceMode =
      item.firstStateFingerprint !== null && item.firstStateFingerprint === item.stateFingerprint ? 'initial' : 'post-transition'
    const participated = await hasOperatorParticipatedInConversation(input.operatorParticipationCheck.conversationId, item.lastChangedAt, mode)
    if (participated) {
      if (item.operatorAwareFingerprint !== item.stateFingerprint) {
        await recordOperatorAwareness({
          workspaceId: input.workspaceId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          evidence: 'Operator sent a customer-facing reply in this conversation themselves.',
        })
      }
      const policy = await policyFor({
        input,
        item: { ...item, notifyCount: Math.max(item.notifyCount, 1) },
        changeKind: 'unchanged',
        blockedOnOperator,
        resolvableAutonomously,
        cooldownActive: false,
        budgetExhausted: false,
      })
      return { outcome: 'SUPPRESS_OPERATOR_AWARE', attentionItemId: item.id, isMaterialChange: false, interruptionPolicy: policy }
    }
  }

  const changed = item.stateFingerprint !== item.notifiedFingerprint
  const isNew = item.notifyCount === 0
  const changeKind: ChangeKind = isNew ? 'new' : changed ? (input.materialChangeKind ?? 'changed') : 'unchanged'
  const policyCooldownBypass = input.materialChangeKind === 'worsened'
  const cooldownActive = await underCooldown(input.workspaceId, input.priority, input.bypassCooldown || policyCooldownBypass)
  const budgetExhausted = BUDGET_PRIORITIES.has(input.priority) ? await interruptionBudgetExhausted(input.workspaceId) : false
  const policy = await policyFor({ input, item, changeKind, blockedOnOperator, resolvableAutonomously, cooldownActive, budgetExhausted })

  if (policy.action === 'WATCH' || policy.action === 'GATHER_EVIDENCE' || policy.action === 'SUPPRESS_AWARE' || policy.action === 'SUPPRESS_UNCHANGED') {
    return {
      outcome: cooldownActive || budgetExhausted ? 'SUPPRESS_RECENTLY_NOTIFIED' : 'SUPPRESS_NO_CHANGE',
      attentionItemId: item.id,
      isMaterialChange: changed && !isNew,
      interruptionPolicy: policy,
    }
  }

  if (policy.action === 'SURFACE_GROUPED') {
    return { outcome: 'SUPPRESS_RECENTLY_NOTIFIED', attentionItemId: item.id, isMaterialChange: changed && !isNew, interruptionPolicy: policy }
  }

  if (isNew) {
    if (cooldownActive && !policy.bypassCooldown) {
      return { outcome: 'SUPPRESS_RECENTLY_NOTIFIED', attentionItemId: item.id, isMaterialChange: false, interruptionPolicy: policy }
    }
    return {
      outcome: input.priority === 'critical' ? 'SEND_CRITICAL_ESCALATION' : 'SEND_NEW',
      attentionItemId: item.id,
      isMaterialChange: false,
      interruptionPolicy: policy,
    }
  }

  if (changed) {
    if (cooldownActive && !policy.bypassCooldown) {
      return { outcome: 'SUPPRESS_RECENTLY_NOTIFIED', attentionItemId: item.id, isMaterialChange: true, interruptionPolicy: policy }
    }
    return {
      outcome: input.priority === 'critical' ? 'SEND_CRITICAL_ESCALATION' : 'SEND_NEW',
      attentionItemId: item.id,
      isMaterialChange: true,
      interruptionPolicy: policy,
    }
  }

  if (item.status === 'acknowledged') {
    return { outcome: 'SUPPRESS_NO_CHANGE', attentionItemId: item.id, isMaterialChange: false, interruptionPolicy: policy }
  }

  const threshold = reminderThresholdMs(input.priority, blockedOnOperator)
  if (threshold === null) return { outcome: 'SUPPRESS_NO_CHANGE', attentionItemId: item.id, isMaterialChange: false, interruptionPolicy: policy }

  const elapsed = item.lastNotifiedAt ? Date.now() - new Date(item.lastNotifiedAt).getTime() : Infinity
  const effectiveThreshold = await lengthenIfReadUnanswered(item, threshold)
  if (elapsed < effectiveThreshold) {
    return { outcome: 'SUPPRESS_RECENTLY_NOTIFIED', attentionItemId: item.id, isMaterialChange: false, interruptionPolicy: policy }
  }
  return { outcome: 'SEND_REMINDER', attentionItemId: item.id, isMaterialChange: false, interruptionPolicy: policy }
}

export async function recordOperatorNotified(args: {
  workspaceId: string
  subjectType: string
  subjectId: string
  summary: string
  queueId?: string
}): Promise<void> {
  await markAttentionNotified(args)
}

async function underCooldown(workspaceId: string, priority: AttentionPriority, bypass: boolean | undefined): Promise<boolean> {
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

/** Rolling 24h budget over actual proactive operator interruptions. */
async function interruptionBudgetExhausted(workspaceId: string): Promise<boolean> {
  try {
    const supabase = createServiceClient()
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data } = await supabase
      .from('caye_outbound_queue')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'sent')
      .gte('sent_at', since)
      .limit(DAILY_INTERRUPTION_BUDGET)
    return (data?.length ?? 0) >= DAILY_INTERRUPTION_BUDGET
  } catch (err) {
    console.error('[operator-notification-gate] interruption budget check failed:', err)
    return false
  }
}

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
    if (data?.wa_delivery_status === 'read') return baseThresholdMs * READ_UNANSWERED_PATIENCE_MULTIPLIER
  } catch (err) {
    console.error('[operator-notification-gate] read-receipt check failed:', err)
  }
  return baseThresholdMs
}
