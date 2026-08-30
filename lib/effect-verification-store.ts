import 'server-only'
import { createServiceClient } from './supabase-server'
import {
  deriveEffectVerification,
  type EffectObservation,
  type EffectVerificationResult,
  type ExecutionReceipt,
} from './effect-verification'

export async function verifyAndPersistEffect(args: {
  workspaceId: string
  effectId: string
  effect: string
  objectiveId?: string | null
  idempotencyKey: string
  expectedState: Record<string, unknown>
  authorityRef?: string | null
  requestedAt: string
  execution: ExecutionReceipt
  observation: EffectObservation | null
}): Promise<EffectVerificationResult> {
  const result = deriveEffectVerification({
    workspaceId: args.workspaceId,
    effect: args.effect,
    expected: args.expectedState,
    execution: args.execution,
    observation: args.observation,
  })

  const supabase = createServiceClient()
  const { error } = await supabase.from('caye_effect_verifications').upsert(
    {
      workspace_id: args.workspaceId,
      effect_id: args.effectId,
      effect: args.effect,
      objective_id: args.objectiveId ?? null,
      idempotency_key: args.idempotencyKey,
      expected_state: args.expectedState,
      authority_ref: args.authorityRef ?? null,
      requested_at: args.requestedAt,
      attempted_at: result.execution.attemptedAt,
      execution_status: result.execution.ok ? 'executed' : 'failed',
      execution_receipt: result.execution,
      execution_error: result.execution.error ?? null,
      executed_at: result.execution.executedAt ?? null,
      verification_status: result.status,
      observed_state: result.observation?.state ?? null,
      observation_source: result.observation?.source ?? null,
      observation_error: result.observation?.error ?? null,
      observation_provenance_ref: result.observation?.provenanceRef ?? null,
      observed_at: result.observation?.observedAt ?? null,
      comparison: result.comparisons,
      verification_reason: result.reason,
      verified_at: result.status === 'VERIFIED' ? result.observation?.observedAt ?? null : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'workspace_id,idempotency_key' }
  )

  if (error) throw new Error(`Could not persist effect verification: ${error.message}`)
  return result
}
