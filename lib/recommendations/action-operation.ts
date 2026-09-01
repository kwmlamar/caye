import 'server-only'

import type { PendingOperationRow } from '@/lib/pending-operations'

export type RecommendationOperationInspection = {
  recommendationVersion: string
  latestDecisionId: string | null
  latestDecision: 'pending' | 'accepted' | 'rejected' | 'deferred' | 'cancelled' | null
  executionState: 'approved_queued' | 'acting_now' | 'completed' | 'failed_needs_attention' | null
}

export type RecommendationExecutionOutcome =
  | { status: 'completed'; material: boolean; executionRef?: string | null }
  | { status: 'waiting_for_founder' }
  | { status: 'retryable_failure'; error: string }
  | { status: 'failed_needs_attention'; error: string; consequential: boolean }

export type RecommendationActionRuntime = {
  inspect: (recommendationId: string, workspaceId: string) => Promise<RecommendationOperationInspection | null>
  execute: (input: {
    recommendationId: string
    workspaceId: string
    recommendationVersion: string
    decisionId: string | null
    idempotencyKey: string
  }) => Promise<RecommendationExecutionOutcome>
  setExecutionState: (input: {
    recommendationId: string
    workspaceId: string
    recommendationVersion: string
    state: 'approved_queued' | 'acting_now' | 'completed' | 'failed_needs_attention'
    executionRef?: string | null
    error?: string | null
  }) => Promise<boolean>
  requireFailureAttention: (input: { recommendationId: string; workspaceId: string; error: string }) => Promise<void>
  surfaceMaterialCompletion: (input: { recommendationId: string; workspaceId: string; executionRef?: string | null }) => Promise<void>
}

export type RecommendationActionOperationResult =
  | { disposition: 'synced'; reason: string }
  | { disposition: 'retry'; error: string }
  | { disposition: 'dead_letter'; error: string }

function stringPayload(row: PendingOperationRow, key: string): string | null {
  const value = row.payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Queued identity is never executable by itself; every effect is revalidated. */
export async function runRecommendationActionOperation(
  row: PendingOperationRow,
  runtime: RecommendationActionRuntime,
): Promise<RecommendationActionOperationResult> {
  const recommendationId = stringPayload(row, 'recommendation_id')
  const queuedVersion = stringPayload(row, 'recommendation_version')
  const queuedDecisionId = stringPayload(row, 'decision_id')
  if (!recommendationId || !queuedVersion) return { disposition: 'dead_letter', error: 'recommendation operation payload is missing identity/version' }

  const current = await runtime.inspect(recommendationId, row.workspace_id)
  if (!current) return { disposition: 'synced', reason: 'recommendation_missing_or_out_of_scope' }
  if (current.recommendationVersion !== queuedVersion) return { disposition: 'synced', reason: 'recommendation_version_changed' }
  if (queuedDecisionId && current.latestDecisionId !== queuedDecisionId) return { disposition: 'synced', reason: 'recommendation_decision_changed' }
  if (current.latestDecision === 'pending') return { disposition: 'synced', reason: 'waiting_for_founder' }
  if (current.latestDecision === 'rejected' || current.latestDecision === 'deferred' || current.latestDecision === 'cancelled') return { disposition: 'synced', reason: 'terminal_decision' }
  if (current.latestDecision !== 'accepted') return { disposition: 'synced', reason: 'recommendation_not_accepted' }
  if (current.executionState === 'completed' || current.executionState === 'failed_needs_attention') return { disposition: 'synced', reason: 'terminal_execution_state' }

  // Only a claimed worker operation may publish this state. Accepted/queued is
  // deliberately not called acting until immediately before the canonical bridge.
  await runtime.setExecutionState({
    recommendationId,
    workspaceId: row.workspace_id,
    recommendationVersion: queuedVersion,
    state: 'acting_now',
  })

  const outcome = await runtime.execute({
    recommendationId,
    workspaceId: row.workspace_id,
    recommendationVersion: queuedVersion,
    decisionId: queuedDecisionId,
    idempotencyKey: row.idempotency_key,
  })

  if (outcome.status === 'waiting_for_founder') {
    await runtime.setExecutionState({ recommendationId, workspaceId: row.workspace_id, recommendationVersion: queuedVersion, state: 'approved_queued' })
    return { disposition: 'synced', reason: 'waiting_for_founder' }
  }
  if (outcome.status === 'retryable_failure') {
    await runtime.setExecutionState({ recommendationId, workspaceId: row.workspace_id, recommendationVersion: queuedVersion, state: 'approved_queued', error: outcome.error })
    return { disposition: 'retry', error: outcome.error }
  }
  if (outcome.status === 'failed_needs_attention') {
    await runtime.setExecutionState({ recommendationId, workspaceId: row.workspace_id, recommendationVersion: queuedVersion, state: 'failed_needs_attention', error: outcome.error })
    if (outcome.consequential) await runtime.requireFailureAttention({ recommendationId, workspaceId: row.workspace_id, error: outcome.error })
    return { disposition: 'dead_letter', error: outcome.error }
  }

  await runtime.setExecutionState({
    recommendationId,
    workspaceId: row.workspace_id,
    recommendationVersion: queuedVersion,
    state: 'completed',
    executionRef: outcome.executionRef ?? null,
  })
  if (outcome.material) await runtime.surfaceMaterialCompletion({ recommendationId, workspaceId: row.workspace_id, executionRef: outcome.executionRef ?? null })
  return { disposition: 'synced', reason: 'completed' }
}
