import { createHash } from 'crypto'

/**
 * Canonical, side-effect-free interruption policy.
 *
 * Domain producers remain responsible for observing authoritative state and
 * the existing owner-attention ledger remains responsible for durable
 * lifecycle/delivery state. This module answers one narrower question:
 * given the current durable state, what SHOULD happen now and why?
 */
export type InterruptionLevel = 'low' | 'medium' | 'high' | 'critical'
export type ConfidenceLevel = 'low' | 'medium' | 'high' | 'verified'
export type ChangeKind = 'new' | 'changed' | 'unchanged' | 'improved' | 'worsened' | 'resolved'
export type AwarenessState = 'unseen' | 'surfaced' | 'acknowledged' | 'being_handled' | 'resolved'

export type InterruptionAction =
  | 'SURFACE_NOW'
  | 'SURFACE_GROUPED'
  | 'WATCH'
  | 'GATHER_EVIDENCE'
  | 'SUPPRESS_UNCHANGED'
  | 'SUPPRESS_AWARE'
  | 'RESOLVE_SILENTLY'
  | 'HANDLE_AUTONOMOUSLY'

export interface InterruptionPolicyInput {
  workspaceId: string
  subjectType: string
  subjectId: string
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

export interface InterruptionPolicyDecision {
  action: InterruptionAction
  bypassCooldown: boolean
  bypassBudget: boolean
  reasonCodes: string[]
}

/** Workspace scope is part of identity, so equal domain ids in two workspaces
 * can never collapse into one interruption issue. */
export function interruptionFingerprint(args: {
  workspaceId: string
  subjectType: string
  subjectId: string
  meaningfulState: unknown[]
}): string {
  return createHash('sha256')
    .update([args.workspaceId, args.subjectType, args.subjectId, ...args.meaningfulState]
      .map((value) => (value == null ? '' : String(value)))
      .join('\u0000'))
    .digest('hex')
    .slice(0, 32)
}

function severe(input: InterruptionPolicyInput): boolean {
  return (
    input.confidence === 'verified' &&
    (input.urgency === 'critical' ||
      (input.urgency === 'high' && input.importance === 'critical') ||
      input.consequencesOfWaiting === 'critical')
  )
}

/** Deterministic policy. Semantic interpretation may populate the dimensions,
 * but an LLM never gets to silently override cooldown/budget/authority rules. */
export function evaluateInterruption(input: InterruptionPolicyInput): InterruptionPolicyDecision {
  const urgentBypass = severe(input)

  if (input.changeKind === 'resolved' || input.awareness === 'resolved') {
    return { action: 'RESOLVE_SILENTLY', bypassCooldown: false, bypassBudget: false, reasonCodes: ['resolved'] }
  }

  if (input.resolvableAutonomously) {
    if (input.authorityAllowsAutonomousAction && !input.blockedOnOperator) {
      return {
        action: 'HANDLE_AUTONOMOUSLY',
        bypassCooldown: false,
        bypassBudget: false,
        reasonCodes: ['autonomously_resolvable', 'authority_allows'],
      }
    }
    if (!input.authorityAllowsAutonomousAction) {
      return {
        action: 'SURFACE_NOW',
        bypassCooldown: urgentBypass,
        bypassBudget: urgentBypass,
        reasonCodes: ['autonomously_resolvable', 'authority_blocks_action'],
      }
    }
  }

  if (input.changeKind === 'unchanged') {
    if (input.awareness === 'acknowledged' || input.awareness === 'being_handled') {
      return { action: 'SUPPRESS_AWARE', bypassCooldown: false, bypassBudget: false, reasonCodes: ['operator_already_aware', 'unchanged'] }
    }
    // Important unresolved items remain eligible for the gate's deliberately
    // slow reminder cadence. The policy does not turn "surfaced once" into
    // permanent silence; awareness/routine items do stay silent when unchanged.
    if (input.awareness === 'surfaced' && (input.importance === 'high' || input.importance === 'critical')) {
      return { action: 'SURFACE_NOW', bypassCooldown: false, bypassBudget: false, reasonCodes: ['unchanged', 'paced_reminder_eligible'] }
    }
    if (!urgentBypass) {
      return { action: 'SUPPRESS_UNCHANGED', bypassCooldown: false, bypassBudget: false, reasonCodes: ['unchanged'] }
    }
  }

  if (input.confidence === 'low' && !urgentBypass) {
    return {
      action: input.consequencesOfWaiting === 'high' || input.consequencesOfWaiting === 'critical'
        ? 'GATHER_EVIDENCE'
        : 'WATCH',
      bypassCooldown: false,
      bypassBudget: false,
      reasonCodes: ['low_confidence', 'avoid_unverified_claim'],
    }
  }

  if (input.changeKind === 'improved' && !input.blockedOnOperator && !urgentBypass) {
    return { action: 'WATCH', bypassCooldown: false, bypassBudget: false, reasonCodes: ['improved', 'not_blocked_on_operator'] }
  }

  if (input.cooldownActive && !urgentBypass && input.changeKind !== 'worsened') {
    return { action: 'WATCH', bypassCooldown: false, bypassBudget: false, reasonCodes: ['cooldown_active'] }
  }

  if (input.interruptionBudgetExhausted && !urgentBypass) {
    return {
      action: input.importance === 'high' || input.importance === 'critical' ? 'SURFACE_GROUPED' : 'WATCH',
      bypassCooldown: false,
      bypassBudget: false,
      reasonCodes: ['interruption_budget_exhausted'],
    }
  }

  return {
    action: 'SURFACE_NOW',
    bypassCooldown: urgentBypass || input.changeKind === 'worsened',
    bypassBudget: urgentBypass,
    reasonCodes: [
      input.changeKind === 'worsened' ? 'material_worsening' : input.changeKind,
      urgentBypass ? 'verified_urgent_bypass' : 'operator_attention_warranted',
    ],
  }
}
