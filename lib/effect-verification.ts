export type EffectVerificationStatus = 'VERIFIED' | 'PARTIAL' | 'FAILED' | 'INDETERMINATE'

export type ExecutionReceipt = {
  ok: boolean
  attemptedAt: string
  executedAt?: string | null
  providerRequestId?: string | null
  externalId?: string | null
  httpStatus?: number | null
  error?: string | null
  details?: Record<string, unknown> | null
}

export type EffectObservation = {
  workspaceId: string
  effect: string
  observedAt: string
  source: string
  state?: Record<string, unknown> | null
  error?: string | null
  provenanceRef?: string | null
}

export type FieldComparison = {
  field: string
  expected: unknown
  observed: unknown
  matches: boolean
  missing: boolean
}

export type EffectVerificationResult = {
  status: EffectVerificationStatus
  execution: ExecutionReceipt
  observation: EffectObservation | null
  comparisons: FieldComparison[]
  reason: string
}

export type EffectRetryDecision = {
  retryMutation: boolean
  recovery: 'none' | 'observe_only' | 'retry_allowed' | 'manual_review'
  reason: string
}

function comparable(value: unknown): string {
  if (value === undefined) return '__undefined__'
  if (value === null) return '__null__'
  if (typeof value === 'string') return value.trim()
  return JSON.stringify(value)
}

export function compareExpectedState(
  expected: Record<string, unknown>,
  observed: Record<string, unknown>
): FieldComparison[] {
  return Object.entries(expected).map(([field, expectedValue]) => {
    const hasField = Object.prototype.hasOwnProperty.call(observed, field)
    const observedValue = hasField ? observed[field] : undefined
    return {
      field,
      expected: expectedValue,
      observed: observedValue,
      matches: hasField && comparable(expectedValue) === comparable(observedValue),
      missing: !hasField,
    }
  })
}

export function deriveEffectVerification(args: {
  workspaceId: string
  effect: string
  expected: Record<string, unknown>
  execution: ExecutionReceipt
  observation: EffectObservation | null
}): EffectVerificationResult {
  const { workspaceId, effect, expected, execution, observation } = args

  if (!execution.ok) {
    return {
      status: 'FAILED',
      execution,
      observation,
      comparisons: [],
      reason: execution.error || 'Execution failed',
    }
  }

  if (!execution.executedAt) {
    return {
      status: 'INDETERMINATE',
      execution,
      observation,
      comparisons: [],
      reason: execution.error || 'Execution outcome is ambiguous; no execution timestamp is available',
    }
  }

  if (!observation || observation.error || !observation.state) {
    return {
      status: 'INDETERMINATE',
      execution,
      observation,
      comparisons: [],
      reason: observation?.error || 'Independent observation unavailable',
    }
  }

  if (observation.workspaceId !== workspaceId) {
    return {
      status: 'FAILED',
      execution,
      observation,
      comparisons: [],
      reason: 'Observation belongs to a different workspace',
    }
  }

  if (observation.effect !== effect) {
    return {
      status: 'FAILED',
      execution,
      observation,
      comparisons: [],
      reason: 'Observation belongs to a different effect',
    }
  }

  const executedAtMs = Date.parse(execution.executedAt)
  const observedAtMs = Date.parse(observation.observedAt)
  if (!Number.isFinite(executedAtMs) || !Number.isFinite(observedAtMs)) {
    return {
      status: 'INDETERMINATE',
      execution,
      observation,
      comparisons: [],
      reason: 'Execution or observation timestamp is invalid',
    }
  }

  if (observedAtMs < executedAtMs) {
    return {
      status: 'INDETERMINATE',
      execution,
      observation,
      comparisons: [],
      reason: 'Observation predates execution and cannot prove the effect',
    }
  }

  const comparisons = compareExpectedState(expected, observation.state)
  if (comparisons.length === 0) {
    return {
      status: 'INDETERMINATE',
      execution,
      observation,
      comparisons,
      reason: 'No expected state was supplied for verification',
    }
  }

  const matched = comparisons.filter(c => c.matches).length
  if (matched === comparisons.length) {
    return {
      status: 'VERIFIED',
      execution,
      observation,
      comparisons,
      reason: 'Independent observation matches every expected field',
    }
  }

  if (matched > 0) {
    return {
      status: 'PARTIAL',
      execution,
      observation,
      comparisons,
      reason: 'Independent observation matches only part of the expected state',
    }
  }

  return {
    status: 'FAILED',
    execution,
    observation,
    comparisons,
    reason: 'Independent observation does not match the expected state',
  }
}

export function deriveEffectRetryDecision(args: {
  status: EffectVerificationStatus
  actionKind: 'create' | 'update' | 'delete' | string
  providerFailureRetryable?: boolean
}): EffectRetryDecision {
  if (args.status === 'VERIFIED') {
    return { retryMutation: false, recovery: 'none', reason: 'Effect is independently verified' }
  }
  if (args.status === 'INDETERMINATE') {
    return {
      retryMutation: false,
      recovery: 'observe_only',
      reason: args.actionKind === 'create'
        ? 'Create may already have succeeded; observe/reconcile before any mutation retry'
        : 'Outcome is ambiguous; observe/reconcile before retrying the mutation',
    }
  }
  if (args.status === 'PARTIAL') {
    return {
      retryMutation: false,
      recovery: 'manual_review',
      reason: 'A partial external effect exists; blind retry could compound the mutation',
    }
  }
  if (args.providerFailureRetryable) {
    return { retryMutation: true, recovery: 'retry_allowed', reason: 'Execution failed definitively before the intended effect and provider classifies retry as safe' }
  }
  return { retryMutation: false, recovery: 'manual_review', reason: 'Failure is not proven safe to retry automatically' }
}
