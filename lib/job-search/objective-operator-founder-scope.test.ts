/**
 * objective-operator.ts:65 passes `workspaceId: null` (with `scopeKind:
 * 'founder'`) to the shared (lib/operator) durable-objective store. The
 * structural grep in leakage.test.ts can tell that literal apart from a real
 * workspace id by text shape, but text shape is a weak instrument — it would
 * be fooled by, say, a variable named to look like a literal. This test
 * asserts the actual behavior instead: it mocks every dependency of
 * runFounderJobSearchObjective and inspects the exact value handed to
 * openOrResumeObjectiveRun.
 *
 * Why `workspaceId: null` is correct rather than a leak: the shared store's
 * schema (operator_objective_runs' CHECK constraint, see
 * supabase/migrations/20260830_operator_objective_runs.sql) requires
 * `scope_kind = 'founder' implies workspace_id IS NULL`. Passing anything
 * else here would fail at the database, not silently leak.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

describe('runFounderJobSearchObjective — explicit founder scope, not a leaked workspace value', () => {
  it('opens its durable run with scopeKind "founder" and workspaceId exactly null', async () => {
    const openOrResumeObjectiveRun = vi.fn(async (_input: { scopeKind: string; workspaceId: string | null }) => ({
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
    }))
    const finalizeObjectiveRun = vi.fn(async () => undefined)
    const persistObjectiveEvent = vi.fn(async () => undefined)
    const runBoundedObjective = vi.fn(async () => ({
      status: 'completed' as const,
      completedSteps: [],
      transitionsUsed: 0,
      planRevision: 0,
    }))
    const recordObjectiveDirectionEvidence = vi.fn(async () => ({ recorded: 0 }))
    const runJobSearchPreparation = vi.fn()
    const runJobSearchInspection = vi.fn()

    vi.doMock('@/lib/operator/objective-store', () => ({ openOrResumeObjectiveRun, finalizeObjectiveRun, persistObjectiveEvent }))
    vi.doMock('@/lib/operator/objective-run', () => ({ runBoundedObjective }))
    vi.doMock('@/lib/operator/direction-evidence', () => ({ recordObjectiveDirectionEvidence }))
    vi.doMock('@/app/api/caye/job-search-prepare/route', () => ({ runJobSearchPreparation }))
    vi.doMock('@/app/api/caye/job-search-inspect/route', () => ({ runJobSearchInspection }))
    vi.doMock('@/lib/supabase-server', () => ({
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            order: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }))

    const { runFounderJobSearchObjective } = await import('./objective-operator')
    await runFounderJobSearchObjective()

    expect(openOrResumeObjectiveRun).toHaveBeenCalledTimes(1)
    const call = openOrResumeObjectiveRun.mock.calls[0][0] as { scopeKind: string; workspaceId: string | null }
    expect(call.scopeKind).toBe('founder')
    expect(call.workspaceId).toBeNull()
  })
})
