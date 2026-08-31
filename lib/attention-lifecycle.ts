export type AttentionLifecycleStatus = 'open' | 'acknowledged' | 'decided' | 'resolved' | 'dismissed'

export interface AttentionLifecycleState {
  status: AttentionLifecycleStatus
  stateFingerprint: string | null
  notifiedFingerprint: string | null
  operatorAwareFingerprint: string | null
  blockedOnOperator: boolean
  resolvableAutonomously: boolean
  pendingNotification: boolean
  notificationDelivered: boolean
  underlyingCompleted: boolean
}

export type AttentionLifecycleAction =
  | 'NOTIFY'
  | 'SUPPRESS_UNCHANGED'
  | 'SUPPRESS_IN_FLIGHT'
  | 'SUPPRESS_OPERATOR_AWARE'
  | 'RESOLVE_AUTONOMOUS'
  | 'RETIRE_COMPLETED'
  | 'WAIT_FOR_DECISION'
  | 'NO_ACTION'

/**
 * One policy for scheduled objectives, proactive notifications and direct UI.
 * Delivery is intentionally NOT awareness. Awareness requires independent
 * interaction/read evidence to have stamped operatorAwareFingerprint.
 */
export function decideAttentionLifecycle(s: AttentionLifecycleState): AttentionLifecycleAction {
  if (s.underlyingCompleted) return 'RETIRE_COMPLETED'
  if (s.status === 'resolved' || s.status === 'dismissed') return 'NO_ACTION'
  if (s.pendingNotification) return 'SUPPRESS_IN_FLIGHT'
  if (!s.blockedOnOperator && s.resolvableAutonomously) return 'RESOLVE_AUTONOMOUS'

  const fp = s.stateFingerprint
  if (fp && s.operatorAwareFingerprint === fp) {
    return s.status === 'acknowledged' || s.status === 'decided'
      ? 'WAIT_FOR_DECISION'
      : 'SUPPRESS_OPERATOR_AWARE'
  }

  if (fp && s.notifiedFingerprint === fp) {
    return s.status === 'acknowledged' || s.status === 'decided'
      ? 'WAIT_FOR_DECISION'
      : 'SUPPRESS_UNCHANGED'
  }

  return 'NOTIFY'
}

export function shouldReopen(previousFingerprint: string | null, nextFingerprint: string | null): boolean {
  return Boolean(nextFingerprint && nextFingerprint !== previousFingerprint)
}

export interface AttentionPrioritySignals {
  severity: number
  urgency: number
  reversibility: number
  authorityNeed: number
  deadline: number
  customerImpact: number
  autonomouslyResolvable: boolean
}

/** Higher score means earlier attention. Reversibility lowers urgency. */
export function attentionPriorityScore(s: AttentionPrioritySignals): number {
  return (
    s.severity * 6 +
    s.urgency * 5 +
    s.authorityNeed * 5 +
    s.deadline * 4 +
    s.customerImpact * 4 -
    s.reversibility * 2 -
    (s.autonomouslyResolvable ? 8 : 0)
  )
}
