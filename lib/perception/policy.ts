export type PerceptionSeverity = 'info' | 'notice' | 'warning' | 'critical'
export type ChangeKind = 'initial' | 'unchanged' | 'ordinary_change' | 'anomaly'

export type InterruptionInput = {
  severity: PerceptionSeverity
  anomaly: boolean
  confidence: number
  fresh: boolean
  sentInWindow: number
  maxInWindow: number
  minutesSinceEquivalentInterrupt: number | null
  cooldownMinutes: number
}

export type InterruptionDecision = {
  interrupt: boolean
  reason:
    | 'critical'
    | 'within_budget'
    | 'stale'
    | 'low_confidence'
    | 'routine'
    | 'budget_exhausted'
    | 'cooldown'
}

/**
 * Policy only. Observation never grants authority to act. This function decides
 * whether already-authorized attention may interrupt an operator.
 */
export function decideInterruption(input: InterruptionInput): InterruptionDecision {
  if (!input.fresh) return { interrupt: false, reason: 'stale' }
  if (input.confidence < 0.7) return { interrupt: false, reason: 'low_confidence' }

  // Critical observations may pierce the normal count budget, but equivalent
  // repeated alerts still respect cooldown. Humans remain tragically finite.
  if (
    input.minutesSinceEquivalentInterrupt !== null &&
    input.minutesSinceEquivalentInterrupt < input.cooldownMinutes
  ) {
    return { interrupt: false, reason: 'cooldown' }
  }

  if (input.severity === 'critical') return { interrupt: true, reason: 'critical' }
  if (!input.anomaly && input.severity !== 'warning') return { interrupt: false, reason: 'routine' }
  if (input.sentInWindow >= input.maxInWindow) return { interrupt: false, reason: 'budget_exhausted' }
  return { interrupt: true, reason: 'within_budget' }
}

export function retryDelaySeconds(consecutiveFailures: number, baseSeconds = 60, maxSeconds = 3600): number {
  const failures = Math.max(1, Math.floor(consecutiveFailures))
  return Math.min(maxSeconds, baseSeconds * 2 ** Math.min(failures - 1, 10))
}

export function classifyChange(previousFingerprint: string | null, nextFingerprint: string, anomaly = false): ChangeKind {
  if (anomaly) return 'anomaly'
  if (previousFingerprint === null) return 'initial'
  return previousFingerprint === nextFingerprint ? 'unchanged' : 'ordinary_change'
}

export function observationDedupeKey(input: {
  workspaceId: string
  sourceKind: string
  sourceIdentity: string
  sourceEventId: string
}): string {
  // Include workspace in the identity even when a provider claims globally unique IDs.
  // Cross-workspace collisions must fail closed rather than correlate tenants together.
  return [input.workspaceId, input.sourceKind, input.sourceIdentity, input.sourceEventId]
    .map((part) => part.trim())
    .join(':')
}
