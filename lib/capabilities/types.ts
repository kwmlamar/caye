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

export type CapabilityName = `${CapabilityNamespace}.${string}`

/**
 * Public, model-agnostic description of a capability.
 *
 * This intentionally exposes semantic contracts, not database/storage details or
 * implementation-specific function names. A reasoning layer should only need this
 * manifest plus the invocation envelope to use Caye safely.
 */
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
  /** Required by any implementation that can cause a durable or external side effect. */
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

export type CapabilityResult<T = unknown> = {
  status: CapabilityResultStatus
  data: T | null
  evidence: CapabilityEvidenceRef[]
  executionRef: string | null
  auditRef: string | null
  failure: CapabilityFailure | null
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

export function capabilityWasExecuted(result: CapabilityResult): boolean {
  return result.status === 'executed' && Boolean(result.executionRef)
}
