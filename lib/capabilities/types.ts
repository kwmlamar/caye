import 'server-only'

export const CAPABILITY_RESULT_STATUSES = [
  'observed',
  'inferred',
  'staged',
  'executed',
  'failed',
] as const

export type CapabilityResultStatus = (typeof CAPABILITY_RESULT_STATUSES)[number]

export type CapabilityAccess = 'read' | 'write'
export type CapabilityRisk = 'read_only' | 'low' | 'consequential'
export type CapabilityCaller = 'caye_direct' | 'external_reasoner' | 'internal_procedure'

export type CapabilityNamespace =
  | 'context'
  | 'goals'
  | 'attention'
  | 'artifacts'
  | 'engineering'
  | 'property'
  | 'research'
  | 'growth'
  // Founder-only job-search operator (CAY-192). Never workspace-scoped —
  // capabilities in this namespace must not accept or branch on
  // context.scope.workspaceId, since job_search_* tables have no
  // workspace_id column at all (see supabase/migrations/
  // 20260828z_job_search_operator_v1.sql).
  | 'job_search'

export type CapabilityName = `${CapabilityNamespace}.${string}`

/** Public semantic description only. Reasoning layers never receive handlers. */
export type CapabilityManifestEntry = {
  name: CapabilityName
  version: 1
  namespace: CapabilityNamespace
  description: string
  access: CapabilityAccess
  risk: CapabilityRisk
  inputSchemaId: string
  outputSchemaId: string
}

export type CapabilityActor = {
  kind: 'founder'
  userId: string
}

export type CapabilityScope = {
  workspaceId: string | null
}

export type CapabilityInvocation = {
  capability: CapabilityName
  version: 1
  actor: CapabilityActor
  scope: CapabilityScope
  args: unknown
  caller: CapabilityCaller
  /** Required by implementations that can cause a durable or external side effect. */
  idempotencyKey?: string
}

export type CapabilityEvidenceRef = {
  kind: 'record' | 'artifact' | 'analysis' | 'execution' | 'audit'
  id: string
}

export type CapabilityFailure = {
  code:
    | 'not_found'
    | 'not_authorized'
    | 'invalid_scope'
    | 'invalid_args'
    | 'requires_confirmation'
    | 'execution_failed'
    | 'unavailable'
  message: string
  retryable: boolean
}

type NonExecutedStatus = Exclude<CapabilityResultStatus, 'executed' | 'failed'>

/**
 * Result shape encodes the trust boundary instead of leaving it to caller convention:
 * - only `executed` may carry an executionRef;
 * - `executed` must carry one;
 * - only `failed` may carry a failure object;
 * - `failed` must carry one.
 *
 * This makes "the model said it did it" structurally different from evidence that
 * Caye actually crossed an execution boundary.
 */
export type CapabilityResult<T = unknown> =
  | {
      status: NonExecutedStatus
      data: T | null
      evidence: CapabilityEvidenceRef[]
      executionRef: null
      auditRef: string | null
      failure: null
    }
  | {
      status: 'executed'
      data: T | null
      evidence: CapabilityEvidenceRef[]
      executionRef: string
      auditRef: string | null
      failure: null
    }
  | {
      status: 'failed'
      data: T | null
      evidence: CapabilityEvidenceRef[]
      executionRef: null
      auditRef: string | null
      failure: CapabilityFailure
    }

export type CapabilityExecutionContext = {
  actor: CapabilityActor
  scope: CapabilityScope
  caller: CapabilityCaller
  idempotencyKey?: string
}

export type RegisteredCapability<TArgs = unknown, TResult = unknown> = {
  manifest: CapabilityManifestEntry
  execute: (args: TArgs, context: CapabilityExecutionContext) => Promise<CapabilityResult<TResult>>
}

export function capabilitySucceeded(result: CapabilityResult): boolean {
  return result.status !== 'failed'
}

export function capabilityWasExecuted(result: CapabilityResult): result is Extract<CapabilityResult, { status: 'executed' }> {
  return result.status === 'executed'
}
