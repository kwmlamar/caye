import { describe, expect, it, vi } from 'vitest'
import {
  RECOMMENDATION_WAKE_LIMIT,
  recommendationWakeIdempotencyKey,
  shouldWakeRecommendation,
  stageEligibleRecommendationActions,
  type RecommendationWakeCandidate,
} from './autonomous-worker'
import {
  runRecommendationActionOperation,
  type RecommendationActionRuntime,
  type RecommendationOperationInspection,
} from './action-operation'
import { backoffDelayMs, type PendingOperationRow } from '@/lib/pending-operations'
import type { RecommendationActionPlan } from './action-plan'

const plan: RecommendationActionPlan = {
  capabilityKey: 'schedule_reminder',
  operation: 'execute',
  arguments: { title: 'Follow up', remind_at: '2026-09-02T14:00:00-04:00' },
  expectedEffect: 'Create one bounded internal reminder.',
  preconditions: ['The recommendation and action plan are current.'],
  materiality: 'quiet',
}

function candidate(overrides: Partial<RecommendationWakeCandidate> = {}): RecommendationWakeCandidate {
  return {
    id: 'rec-1', workspaceId: 'ws-1', status: 'proposed', version: 'version-1',
    latestDecisionId: null, latestDecision: null, latestDecisionVersion: null, executionState: null,
    actionPlan: plan, riskClassification: 'low', reversibility: 'easy',
    requiredAuthority: { principalType: 'workspace', principalRef: 'business.policy', resolvedBy: 'canonical_authority' },
    ...overrides,
  }
}

function operation(overrides: Partial<PendingOperationRow> = {}): PendingOperationRow {
  return {
    id: 'op-1', workspace_id: 'ws-1', operation: 'recommendation_action',
    payload: { recommendation_id: 'rec-1', recommendation_version: 'version-1', decision_id: 'decision-1' },
    attempts: 0, max_attempts: 3,
    idempotency_key: 'recommendation_action:rec-1:version-1:decision-1', request_id: null, claim_token: 'claim-1',
    ...overrides,
  }
}

function runtime(overrides: Partial<RecommendationActionRuntime> = {}): RecommendationActionRuntime {
  const inspection: RecommendationOperationInspection = {
    recommendationVersion: 'version-1', latestDecisionId: 'decision-1', latestDecision: 'accepted', executionState: 'approved_queued',
  }
  return {
    inspect: vi.fn(async () => inspection),
    execute: vi.fn(async () => ({ status: 'completed' as const, material: false, executionRef: 'exec-1' })),
    setExecutionState: vi.fn(async () => true),
    requireFailureAttention: vi.fn(async () => undefined),
    surfaceMaterialCompletion: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('autonomous recommendation wake', () => {
  it('wakes an autonomously eligible recommendation without a founder prompt', async () => {
    const enqueue = vi.fn(async () => ({ queued: true, alreadyQueued: false }))
    const result = await stageEligibleRecommendationActions(5, {
      listCandidates: async () => [candidate()],
      decideUndecided: async () => ({ kind: 'accepted', decisionId: 'auto-decision' }),
      enqueue,
    })
    expect(result.queued).toBe(1)
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue.mock.calls[0][0]).toMatchObject({ latestDecision: 'accepted', latestDecisionId: 'auto-decision' })
  })

  it('leaves founder-required recommendations waiting', async () => {
    const enqueue = vi.fn(async () => ({ queued: true, alreadyQueued: false }))
    const result = await stageEligibleRecommendationActions(5, {
      listCandidates: async () => [candidate({ requiredAuthority: { principalType: 'personal', principalRef: 'founder', resolvedBy: 'canonical_authority' } })],
      decideUndecided: async () => ({ kind: 'waiting' }),
      enqueue,
    })
    expect(result.waitingForFounder).toBe(1)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('founder approval resumes through the same canonical queue path', async () => {
    const approved = candidate({ status: 'accepted', latestDecisionId: 'decision-approved', latestDecision: 'accepted', latestDecisionVersion: 'version-1' })
    const enqueue = vi.fn(async () => ({ queued: true, alreadyQueued: false }))
    const result = await stageEligibleRecommendationActions(5, { listCandidates: async () => [approved], enqueue })
    expect(result.queued).toBe(1)
    expect(recommendationWakeIdempotencyKey(approved)).toContain('decision-approved')
  })

  it('does not wake stale approval for a changed recommendation/action-plan version', () => {
    expect(shouldWakeRecommendation(candidate({ status: 'accepted', version: 'version-2', latestDecision: 'accepted', latestDecisionId: 'old-decision', latestDecisionVersion: 'version-1' }))).toBe('stale_approval')
  })

  it('does not wake a recommendation without a validated executable plan', () => {
    expect(shouldWakeRecommendation(candidate({ actionPlan: null }))).toBe('no_plan')
  })

  it('does not wake completed recommendation actions again', () => {
    expect(shouldWakeRecommendation(candidate({ executionState: 'completed' }))).toBe('terminal')
  })

  it('hard caps work per invocation', async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate({ id: `rec-${index}`, latestDecisionId: `decision-${index}`, latestDecision: 'accepted', latestDecisionVersion: 'version-1' }))
    const enqueue = vi.fn(async () => ({ queued: true, alreadyQueued: false }))
    const result = await stageEligibleRecommendationActions(99, { listCandidates: async () => candidates, enqueue })
    expect(result.scanned).toBe(RECOMMENDATION_WAKE_LIMIT)
    expect(enqueue).toHaveBeenCalledTimes(RECOMMENDATION_WAKE_LIMIT)
  })

  it('converges duplicate worker staging on one version + decision idempotency key', async () => {
    const approved = candidate({ latestDecisionId: 'decision-1', latestDecision: 'accepted', latestDecisionVersion: 'version-1' })
    const seen = new Set<string>()
    const enqueue = vi.fn(async (item: RecommendationWakeCandidate) => {
      const key = recommendationWakeIdempotencyKey(item)
      const duplicate = seen.has(key)
      seen.add(key)
      return { queued: true, alreadyQueued: duplicate }
    })
    const deps = { listCandidates: async () => [approved], enqueue }
    const first = await stageEligibleRecommendationActions(5, deps)
    const second = await stageEligibleRecommendationActions(5, deps)
    expect(first.queued).toBe(1)
    expect(second.alreadyQueued).toBe(1)
    expect(seen.size).toBe(1)
  })
})

describe('recommendation action operation', () => {
  it('publishes Acting now only from a claimed operation, then completes through the bridge', async () => {
    const bridge = runtime()
    await expect(runRecommendationActionOperation(operation(), bridge)).resolves.toEqual({ disposition: 'synced', reason: 'completed' })
    expect(bridge.execute).toHaveBeenCalledOnce()
    expect(bridge.setExecutionState).toHaveBeenNthCalledWith(1, expect.objectContaining({ state: 'acting_now' }))
    expect(bridge.setExecutionState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'completed' }))
  })

  it('refuses stale queued work before execution', async () => {
    const bridge = runtime({ inspect: vi.fn(async () => ({ recommendationVersion: 'version-2', latestDecisionId: 'decision-new', latestDecision: 'accepted', executionState: null })) })
    const result = await runRecommendationActionOperation(operation({ payload: { recommendation_id: 'rec-1', recommendation_version: 'version-1', decision_id: 'decision-old' } }), bridge)
    expect(result).toEqual({ disposition: 'synced', reason: 'recommendation_version_changed' })
    expect(bridge.execute).not.toHaveBeenCalled()
  })

  it('returns retryable failures to the existing bounded outbox retry path and leaves queued state', async () => {
    const bridge = runtime({ execute: vi.fn(async () => ({ status: 'retryable_failure' as const, error: 'provider unavailable' })) })
    await expect(runRecommendationActionOperation(operation(), bridge)).resolves.toEqual({ disposition: 'retry', error: 'provider unavailable' })
    expect(bridge.setExecutionState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'approved_queued', error: 'provider unavailable' }))
    expect(backoffDelayMs(1)).toBeGreaterThan(backoffDelayMs(0))
    expect(operation().max_attempts).toBe(3)
  })

  it('creates owner attention only for consequential terminal failure', async () => {
    const bridge = runtime({ execute: vi.fn(async () => ({ status: 'failed_needs_attention' as const, error: 'risk gate changed', consequential: true })) })
    await expect(runRecommendationActionOperation(operation(), bridge)).resolves.toEqual({ disposition: 'dead_letter', error: 'risk gate changed' })
    expect(bridge.requireFailureAttention).toHaveBeenCalledOnce()
  })

  it('duplicate worker invocation does not execute after durable completion is observed', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' as const, material: false, executionRef: 'exec-1' }))
    await runRecommendationActionOperation(operation(), runtime({ execute }))
    const completedBridge = runtime({
      inspect: vi.fn(async () => ({ recommendationVersion: 'version-1', latestDecisionId: 'decision-1', latestDecision: 'accepted', executionState: 'completed' })),
      execute,
    })
    await expect(runRecommendationActionOperation(operation(), completedBridge)).resolves.toEqual({ disposition: 'synced', reason: 'terminal_execution_state' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not spam Direct for non-material successful actions', async () => {
    const bridge = runtime({ execute: vi.fn(async () => ({ status: 'completed' as const, material: false, executionRef: 'exec-quiet' })) })
    await runRecommendationActionOperation(operation(), bridge)
    expect(bridge.surfaceMaterialCompletion).not.toHaveBeenCalled()
  })

  it('surfaces material completion only through the existing projection port', async () => {
    const bridge = runtime({ execute: vi.fn(async () => ({ status: 'completed' as const, material: true, executionRef: 'exec-material' })) })
    await runRecommendationActionOperation(operation(), bridge)
    expect(bridge.surfaceMaterialCompletion).toHaveBeenCalledWith({ recommendationId: 'rec-1', workspaceId: 'ws-1', executionRef: 'exec-material' })
  })
})
