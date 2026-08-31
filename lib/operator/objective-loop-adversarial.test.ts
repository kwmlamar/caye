import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  open: vi.fn(),
  persist: vi.fn(async () => undefined),
  finalize: vi.fn(async () => undefined),
}))

vi.mock('./objective-store', () => ({
  openOrResumeObjectiveRun: store.open,
  persistObjectiveEvent: store.persist,
  finalizeObjectiveRun: store.finalize,
  evaluateDurableRunCompatibility: (input: {
    storedPlanVersion: string
    requestedPlanVersion: string
    deadlineAt: string | null
    nowMs: number
  }) => {
    if (input.storedPlanVersion !== input.requestedPlanVersion) {
      return { status: 'blocked', blockedStep: '__plan_version__', error: 'plan changed' }
    }
    if (input.deadlineAt && Date.parse(input.deadlineAt) <= input.nowMs) {
      return { status: 'failed', blockedStep: '__durable_deadline__', error: 'deadline exceeded' }
    }
    return null
  },
}))

import type { RegisteredCapability } from '@/lib/capabilities/types'
import { runBoundedObjective } from './objective-run'
import { evaluateDurableRunCompatibility } from './objective-store'
import {
  capabilityObjectiveStep,
  isObservationFresh,
  objectiveFingerprint,
  runDurableObjectiveLoop,
} from './objective-loop'

function durable(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    runnerToken: 'lease-1',
    metadata: {},
    maxTransitions: 12,
    completedSteps: new Set<string>(),
    pendingEffects: new Map<string, unknown>(),
    interruptedSteps: new Set<string>(),
    transitionsUsed: 0,
    planRevision: 0,
    maxPlanRevisions: 2,
    ...overrides,
  }
}

function loopInput(overrides: Record<string, unknown> = {}) {
  return {
    supabase: {} as never,
    objectiveKey: 'workspace_health',
    planVersion: '1',
    scopeKind: 'workspace' as const,
    workspaceId: '11111111-1111-1111-1111-111111111111',
    actorKey: 'operator',
    maxTransitions: 12,
    maxPlanRevisions: 2,
    timeoutMs: 30_000,
    maxRunAgeMs: 10 * 60_000,
    observe: async () => ({ state: { healthy: true }, evidence: { source: 'test' } }),
    plan: async () => ({
      context: {},
      steps: [{
        key: 'inspect',
        authority: 'read' as const,
        execute: async () => ({ inspected: true }),
        verify: async (_ctx: object, effect: unknown) => ({ ok: true, evidence: effect }),
      }],
    }),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.open.mockResolvedValue(durable())
})

describe('canonical autonomous objective loop adversarial contract', () => {
  it('suppresses an unchanged blocker before repeating plan work', async () => {
    const state = { outreachDisabled: true, providerHealthy: true }
    const plan = vi.fn()
    store.open.mockResolvedValue(durable({
      metadata: {
        resumeAt: new Date(Date.now() + 60_000).toISOString(),
        objectiveLoop: {
          materialStateFingerprint: objectiveFingerprint(state),
          lastWaitingFingerprint: 'blocked-v1',
          lastWaitingStep: 'route_owner_decision',
        },
      },
    }))

    const result = await runDurableObjectiveLoop(loopInput({
      observe: async () => ({ state }),
      plan,
    }) as never)

    expect(result.status).toBe('waiting')
    expect(result.suppressedUnchangedBlocker).toBe(true)
    expect(plan).not.toHaveBeenCalled()
    expect(store.persist).toHaveBeenCalledWith(expect.anything(), 'run-1', 'lease-1', 30_000, expect.objectContaining({
      state: 'waiting',
      evidence: expect.objectContaining({ suppressedUnchangedBlocker: true }),
    }))
  })

  it('wakes and replans when the blocked material state changes', async () => {
    const previous = { outreachDisabled: true, providerHealthy: false }
    const current = { outreachDisabled: true, providerHealthy: true }
    const plan = vi.fn(async ({ materialChanged }) => ({
      context: {},
      evidence: { materialChanged },
      steps: [{
        key: 'inspect', authority: 'read' as const,
        execute: async () => ({ observed: 'healthy' }),
        verify: async (_ctx: object, effect: unknown) => ({ ok: true, evidence: effect }),
      }],
    }))
    store.open.mockResolvedValue(durable({
      metadata: {
        resumeAt: new Date(Date.now() + 60_000).toISOString(),
        objectiveLoop: {
          materialStateFingerprint: objectiveFingerprint(previous),
          lastWaitingFingerprint: 'blocked-v1',
          lastWaitingStep: 'inspect',
        },
      },
    }))

    const result = await runDurableObjectiveLoop(loopInput({ observe: async () => ({ state: current }), plan }) as never)
    expect(result.status).toBe('completed')
    expect(result.suppressedUnchangedBlocker).toBe(false)
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ materialChanged: true }))
  })

  it('rejects stale perception evidence instead of executing a stale plan', async () => {
    const plan = vi.fn()
    const freshUntil = new Date(Date.now() - 1_000).toISOString()
    expect(isObservationFresh({ state: {}, freshUntil })).toBe(false)

    const result = await runDurableObjectiveLoop(loopInput({
      observe: async () => ({ state: { source: 'old' }, freshUntil }),
      plan,
    }) as never)
    expect(result.status).toBe('waiting')
    expect(result.blockedStep).toBe('__perception__')
    expect(plan).not.toHaveBeenCalled()
  })

  it('records failed execution without pretending the step completed', async () => {
    const result = await runBoundedObjective({
      context: {}, allowedAuthority: new Set(['write_low'] as const),
      steps: [{
        key: 'mutate', authority: 'write_low',
        execute: async () => { throw new Error('provider rejected mutation') },
        verify: async () => ({ ok: true }),
      }],
    })
    expect(result.status).toBe('failed')
    expect(result.completedSteps).toEqual([])
  })

  it('waits on an indeterminate effect and does not auto-replay it', async () => {
    const execute = vi.fn(async () => ({ executionId: 'e-1' }))
    const first = await runBoundedObjective({
      context: {}, allowedAuthority: new Set(['write_low'] as const),
      steps: [{
        key: 'mutate', authority: 'write_low', execute,
        verify: async () => ({ ok: false, indeterminate: true, reason: 'observation unavailable' }),
      }],
    })
    expect(first.status).toBe('waiting')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(first.events.at(-1)?.evidence).toMatchObject({ pendingEffect: { executionId: 'e-1' } })
  })

  it('stops at a consequential authority boundary and routes a decision instead of executing', async () => {
    const execute = vi.fn()
    const authorityRouter = vi.fn(async () => ({
      status: 'decision_required' as const,
      decisionId: 'decision-1',
      decisionOwner: 'workspace_owner',
      reason: 'Owner authority required',
      retryAfterMs: 60_000,
    }))
    const result = await runDurableObjectiveLoop(loopInput({
      authorityRouter,
      plan: async () => ({ context: {}, steps: [{
        key: 'unpause_outreach', authority: 'write_high' as const, execute,
        verify: async () => ({ ok: true }),
      }] }),
    }) as never)
    expect(result.status).toBe('waiting')
    expect(execute).not.toHaveBeenCalled()
    expect(authorityRouter).toHaveBeenCalledTimes(1)
    expect(result.events.at(-1)?.evidence).toMatchObject({
      stateEvidence: expect.objectContaining({ decisionId: 'decision-1', decisionOwner: 'workspace_owner' }),
    })
  })

  it('keeps waiting when the correct owner is unreachable', async () => {
    const execute = vi.fn()
    const result = await runDurableObjectiveLoop(loopInput({
      authorityRouter: async () => ({
        status: 'unreachable' as const,
        decisionOwner: 'workspace_owner',
        reason: 'No verified owner route is currently available',
        retryAfterMs: 120_000,
      }),
      plan: async () => ({ context: {}, steps: [{
        key: 'policy_change', authority: 'write_high' as const, execute,
        verify: async () => ({ ok: true }),
      }] }),
    }) as never)
    expect(result.status).toBe('waiting')
    expect(execute).not.toHaveBeenCalled()
  })

  it('wakes after a later decision becomes part of observed material state', async () => {
    const blockedState = { decision: 'pending' }
    const decidedState = { decision: 'approved' }
    const execute = vi.fn(async () => ({ changed: true }))
    store.open.mockResolvedValue(durable({
      metadata: {
        resumeAt: new Date(Date.now() + 60_000).toISOString(),
        objectiveLoop: {
          materialStateFingerprint: objectiveFingerprint(blockedState),
          lastWaitingFingerprint: 'decision-pending',
          lastWaitingStep: 'unpause_outreach',
        },
      },
    }))

    const result = await runDurableObjectiveLoop(loopInput({
      observe: async () => ({ state: decidedState }),
      authorityRouter: async () => ({ status: 'authorized' as const, evidence: { decisionId: 'decision-1' } }),
      plan: async () => ({ context: {}, steps: [{
        key: 'unpause_outreach', authority: 'write_high' as const, execute,
        verify: async (_ctx: object, effect: unknown) => ({ ok: true, evidence: { observed: effect } }),
      }] }),
    }) as never)
    expect(result.status).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('survives process restart by reconciling a durable pending effect before execution', async () => {
    const execute = vi.fn()
    const result = await runBoundedObjective({
      context: {},
      allowedAuthority: new Set(['write_low'] as const),
      pendingEffects: new Map([['mutate', { executionId: 'e-old' }]]),
      interruptedSteps: new Set(),
      steps: [{
        key: 'mutate', authority: 'write_low', execute,
        verify: async (_ctx, effect) => ({ ok: true, evidence: { reconciled: effect } }),
      }],
    })
    expect(result.status).toBe('completed')
    expect(execute).not.toHaveBeenCalled()
    expect(result.events.at(-1)).toMatchObject({ state: 'verified', attempt: 0 })
  })

  it('fails a durable run whose wall-clock deadline has expired', () => {
    const result = evaluateDurableRunCompatibility({
      storedPlanVersion: '1', requestedPlanVersion: '1',
      deadlineAt: new Date(Date.now() - 1_000).toISOString(), nowMs: Date.now(),
    })
    expect(result).toMatchObject({ status: 'failed', blockedStep: '__durable_deadline__' })
  })

  it('enforces the durable transition budget across resumptions', async () => {
    const execute = vi.fn()
    const result = await runBoundedObjective({
      context: {}, allowedAuthority: new Set(['read'] as const),
      transitionsAlreadyUsed: 4, maxTransitions: 4,
      steps: [{ key: 'inspect', authority: 'read', execute, verify: async () => ({ ok: true }) }],
    })
    expect(result.status).toBe('budget_exhausted')
    expect(result.budgetReason).toBe('transitions')
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not replay an already verified step after a later step causes plan revision', async () => {
    const first = vi.fn(async () => ({ done: true }))
    const second = vi.fn(async () => ({ done: true }))
    let current = 'v2'
    const context = { baseline: 'v1' }
    const result = await runBoundedObjective({
      context,
      allowedAuthority: new Set(['write_low', 'read'] as const),
      onReplan: async ({ context: ctx }) => {
        ctx.baseline = current
        return { context: ctx, evidence: { accepted: current } }
      },
      steps: [
        { key: 'first', authority: 'write_low', execute: first, verify: async () => ({ ok: true }) },
        {
          key: 'second', authority: 'read',
          checkState: async (ctx) => ctx.baseline === current
            ? { status: 'current' as const }
            : { status: 'changed' as const, reason: 'material state changed' },
          execute: second,
          verify: async () => ({ ok: true }),
        },
      ],
    })
    expect(result.status).toBe('completed')
    expect(result.planRevision).toBe(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('rejects a duplicate scheduler invocation when the durable lease is already claimed', async () => {
    store.open.mockRejectedValueOnce(new Error('Objective run is already claimed by another worker'))
    const plan = vi.fn()
    await expect(runDurableObjectiveLoop(loopInput({ plan }) as never)).rejects.toThrow('already claimed')
    expect(plan).not.toHaveBeenCalled()
  })

  it('does not treat a capability executionRef as independent write verification', async () => {
    const capability: RegisteredCapability<Record<string, never>, { ok: true }> = {
      manifest: {
        name: 'research.start', version: 1, namespace: 'research',
        description: 'test write', access: 'write', risk: 'low',
        inputSchemaId: 'test.in', outputSchemaId: 'test.out',
      },
      execute: async () => ({
        status: 'executed', data: { ok: true }, evidence: [], executionRef: 'execution-1', auditRef: null, failure: null,
      }),
    }
    const step = capabilityObjectiveStep({
      key: 'capability_write', capability, args: {},
      capabilityContext: { actor: { kind: 'founder', userId: 'founder' }, scope: { workspaceId: null }, caller: 'internal_procedure' },
    })
    const result = await runBoundedObjective({
      context: {}, allowedAuthority: new Set(['write_low'] as const), steps: [step],
    })
    expect(result.status).toBe('waiting')
    expect(result.completedSteps).toEqual([])
    expect(result.events.at(-1)?.error).toContain('independent objective verifier')
  })
})
