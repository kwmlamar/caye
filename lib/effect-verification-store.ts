import 'server-only'
import { createServiceClient } from './supabase-server'
import {
  deriveEffectVerification,
  type EffectObservation,
  type EffectVerificationResult,
  type ExecutionReceipt,
} from './effect-verification'

function confidence(result: EffectVerificationResult): number {
  if (result.status === 'VERIFIED') return 1
  if (result.status === 'INDETERMINATE') return 0
  if (!result.observation?.state) return result.status === 'FAILED' ? 0.9 : 0
  if (result.comparisons.length === 0) return 0
  return Number((result.comparisons.filter(c => c.matches).length / result.comparisons.length).toFixed(3))
}

export async function verifyAndPersistEffect(args: {
  workspaceId: string
  effectId: string
  effect: string
  actionKind?: string | null
  executionId?: string | null
  objectiveId?: string | null
  idempotencyKey: string
  intendedEffect?: Record<string, unknown>
  expectedState: Record<string, unknown>
  authorityRef?: string | null
  providerIdentity?: string | null
  observationProviderIdentity?: string | null
  requestedAt: string
  execution: ExecutionReceipt
  observation: EffectObservation | null
  retrySafe?: boolean
  recoveryState?: 'none' | 'observe_only' | 'retry_allowed' | 'manual_review' | 'reconciled' | 'abandoned'
  ambiguityReason?: string | null
}): Promise<EffectVerificationResult> {
  const result = deriveEffectVerification({
    workspaceId: args.workspaceId,
    effect: args.effect,
    expected: args.expectedState,
    execution: args.execution,
    observation: args.observation,
  })

  const executionStatus = !result.execution.ok
    ? 'failed'
    : result.execution.executedAt
      ? 'executed'
      : 'indeterminate'
  const ambiguityReason = result.status === 'INDETERMINATE'
    ? args.ambiguityReason ?? result.reason
    : args.ambiguityReason ?? null
  const recoveryState = args.recoveryState ?? (result.status === 'INDETERMINATE' ? 'observe_only' : 'none')

  const supabase = createServiceClient()
  const { error } = await supabase.from('caye_effect_verifications').upsert(
    {
      workspace_id: args.workspaceId,
      effect_id: args.effectId,
      effect: args.effect,
      action_kind: args.actionKind ?? null,
      execution_id: args.executionId ?? null,
      objective_id: args.objectiveId ?? null,
      authority_ref: args.authorityRef ?? null,
      idempotency_key: args.idempotencyKey,
      intended_effect: args.intendedEffect ?? args.expectedState,
      expected_state: args.expectedState,
      requested_at: args.requestedAt,
      attempted_at: result.execution.attemptedAt,
      execution_status: executionStatus,
      execution_receipt: result.execution,
      execution_error: result.execution.error ?? null,
      executed_at: result.execution.executedAt ?? null,
      provider_identity: args.providerIdentity ?? null,
      provider_request_id: result.execution.providerRequestId ?? null,
      provider_external_id: result.execution.externalId ?? null,
      verification_status: result.status,
      verification_confidence: confidence(result),
      observed_state: result.observation?.state ?? null,
      observation_source: result.observation?.source ?? null,
      observation_provider_identity: args.observationProviderIdentity ?? args.providerIdentity ?? null,
      observation_error: result.observation?.error ?? null,
      observation_provenance_ref: result.observation?.provenanceRef ?? null,
      observed_at: result.observation?.observedAt ?? null,
      comparison: result.comparisons,
      verification_reason: result.reason,
      ambiguity_reason: ambiguityReason,
      retry_safe: args.retrySafe ?? false,
      recovery_state: recoveryState,
      verified_at: result.status === 'VERIFIED' ? result.observation?.observedAt ?? null : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'workspace_id,idempotency_key' }
  )

  if (error) throw new Error(`Could not persist effect verification: ${error.message}`)
  return result
}
