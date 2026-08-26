import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

import { createFakeGoalsClient } from './test-support/fake-goals-db'

let fake = createFakeGoalsClient()

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => fake.client,
}))

const {
  listWorkspaceGoals,
  listOperatorScopeGoals,
  listActiveEligibleGoals,
  isActionable,
  listDependencies,
  addDependency,
  resolveAncestorChain,
  getGoal,
  createGoal,
  updateGoal,
  supersedeGoal,
  recordMetric,
  listMetrics,
  listChildren,
} = await import('./goals')

beforeEach(() => {
  fake = createFakeGoalsClient()
})

async function makeGoal(overrides: Partial<Parameters<typeof createGoal>[0]> = {}) {
  const { goal, error } = await createGoal({
    kind: 'goal',
    scope: 'workspace',
    workspaceId: 'ws-a',
    title: 'Test goal',
    createdByKind: 'founder',
    ...overrides,
  })
  if (!goal) throw new Error(`makeGoal failed: ${error}`)
  return goal
}

describe('workspace isolation', () => {
  it('workspace A cannot read workspace B goals via listWorkspaceGoals', async () => {
    await makeGoal({ workspaceId: 'ws-a', title: 'A goal' })
    await makeGoal({ workspaceId: 'ws-b', title: 'B goal' })

    const aGoals = await listWorkspaceGoals('ws-a')
    const bGoals = await listWorkspaceGoals('ws-b')

    expect(aGoals.map((g) => g.title)).toEqual(['A goal'])
    expect(bGoals.map((g) => g.title)).toEqual(['B goal'])
  })

  it('listWorkspaceGoals never returns operator-scope rows', async () => {
    await createGoal({ kind: 'vision', scope: 'operator', title: 'Global vision', createdByKind: 'founder' })
    await makeGoal({ workspaceId: 'ws-a', title: 'A goal' })

    const aGoals = await listWorkspaceGoals('ws-a')
    expect(aGoals.map((g) => g.title)).toEqual(['A goal'])
  })

  it('listOperatorScopeGoals never returns a workspace-scoped row', async () => {
    await createGoal({ kind: 'vision', scope: 'operator', title: 'Global vision', createdByKind: 'founder' })
    await makeGoal({ workspaceId: 'ws-a', title: 'A goal' })

    const operatorGoals = await listOperatorScopeGoals()
    expect(operatorGoals.map((g) => g.title)).toEqual(['Global vision'])
  })

  it('createGoal rejects workspace scope without a workspaceId, and operator scope with one', async () => {
    const missingWorkspace = await createGoal({ kind: 'goal', scope: 'workspace', title: 'x', createdByKind: 'founder' })
    expect(missingWorkspace.goal).toBeNull()
    expect(missingWorkspace.error).toMatch(/workspaceId is required/)

    const strayWorkspace = await createGoal({
      kind: 'goal', scope: 'operator', workspaceId: 'ws-a', title: 'x', createdByKind: 'founder',
    })
    expect(strayWorkspace.goal).toBeNull()
    expect(strayWorkspace.error).toMatch(/must not be set/)
  })
})

describe('active/eligible goal retrieval (what the heartbeat sees)', () => {
  it('future goals are not treated as active', async () => {
    await makeGoal({ title: 'Future thing', status: 'future' })
    await makeGoal({ title: 'Active thing', status: 'active' })

    const eligible = await listActiveEligibleGoals('ws-a')
    expect(eligible.map((g) => g.title)).toEqual(['Active thing'])
  })

  it('blocked goals are not actionable even though status could otherwise qualify', async () => {
    const blocked = await makeGoal({ title: 'Blocked thing', status: 'blocked' })
    expect(await isActionable(blocked)).toBe(false)

    const eligible = await listActiveEligibleGoals('ws-a')
    expect(eligible.find((g) => g.id === blocked.id)).toBeUndefined()
  })

  it('paused goals are not actionable', async () => {
    const paused = await makeGoal({ title: 'Paused thing', status: 'paused' })
    expect(await isActionable(paused)).toBe(false)
  })

  it('completed and abandoned goals never enter active planning', async () => {
    await makeGoal({ title: 'Done', status: 'completed' })
    // "abandoned" here means status=abandoned while not yet superseded — a
    // goal can be marked abandoned without a replacement existing.
    await makeGoal({ title: 'Abandoned', status: 'abandoned' })
    await makeGoal({ title: 'Active', status: 'active' })

    const eligible = await listActiveEligibleGoals('ws-a')
    expect(eligible.map((g) => g.title)).toEqual(['Active'])
  })

  it('a superseded goal is excluded from every listing regardless of its status', async () => {
    const original = await makeGoal({ title: 'Old target', status: 'active' })
    await supersedeGoal(original.id, {
      kind: 'goal', scope: 'workspace', workspaceId: 'ws-a', title: 'New target',
      status: 'active', createdByKind: 'founder',
    })

    const workspaceGoals = await listWorkspaceGoals('ws-a')
    expect(workspaceGoals.map((g) => g.title)).toEqual(['New target'])
    const eligible = await listActiveEligibleGoals('ws-a')
    expect(eligible.map((g) => g.title)).toEqual(['New target'])
  })
})

describe('dependencies / prerequisites', () => {
  it('a goal with an unsatisfied dependency is not actionable', async () => {
    const prerequisite = await makeGoal({ title: 'Prerequisite', status: 'active' })
    const dependent = await makeGoal({ title: 'Dependent', status: 'active' })
    await addDependency(dependent.id, prerequisite.id)

    expect(await isActionable(dependent)).toBe(false)
  })

  it('a goal becomes actionable once its dependency is completed', async () => {
    const prerequisite = await makeGoal({ title: 'Prerequisite', status: 'completed' })
    const dependent = await makeGoal({ title: 'Dependent', status: 'active' })
    await addDependency(dependent.id, prerequisite.id)

    expect(await isActionable(dependent)).toBe(true)
  })

  it('a goal with no dependencies is actionable purely on its own active status', async () => {
    const standalone = await makeGoal({ title: 'Standalone', status: 'active' })
    expect(await isActionable(standalone)).toBe(true)
  })

  it('a goal cannot depend on itself', async () => {
    const goal = await makeGoal({ title: 'Self' })
    const result = await addDependency(goal.id, goal.id)
    expect(result.ok).toBe(false)
  })

  it('adding the same dependency twice is idempotent, not a duplicate error', async () => {
    const prerequisite = await makeGoal({ title: 'Prerequisite' })
    const dependent = await makeGoal({ title: 'Dependent' })
    const first = await addDependency(dependent.id, prerequisite.id)
    const second = await addDependency(dependent.id, prerequisite.id)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    const deps = await listDependencies(dependent.id)
    expect(deps.length).toBe(1)
  })

  it('listActiveEligibleGoals excludes an active goal blocked by an incomplete prerequisite', async () => {
    const prerequisite = await makeGoal({ title: 'Prerequisite', status: 'active' })
    const dependent = await makeGoal({ title: 'Dependent', status: 'active' })
    await addDependency(dependent.id, prerequisite.id)

    const eligible = await listActiveEligibleGoals('ws-a')
    // prerequisite itself has no dependencies, so it's eligible; dependent is not.
    expect(eligible.map((g) => g.title)).toEqual(['Prerequisite'])
  })
})

describe('goal relationships resolve correctly (the "why" chain)', () => {
  it('resolveAncestorChain traces parent_id up to the root', async () => {
    const vision = await createGoal({ kind: 'vision', scope: 'operator', title: 'Vision', createdByKind: 'founder' })
    const domain = await createGoal({
      kind: 'domain', scope: 'operator', parentId: vision.goal!.id, title: 'Business', createdByKind: 'founder',
    })
    const objective = await createGoal({
      kind: 'objective', scope: 'operator', parentId: domain.goal!.id, title: 'MRR', createdByKind: 'founder',
    })

    const chain = await resolveAncestorChain(objective.goal!.id)
    expect(chain.map((g) => g.title)).toEqual(['MRR', 'Business', 'Vision'])
  })

  it('a root goal (no parent) resolves a chain of just itself', async () => {
    const vision = await createGoal({ kind: 'vision', scope: 'operator', title: 'Vision', createdByKind: 'founder' })
    const chain = await resolveAncestorChain(vision.goal!.id)
    expect(chain.map((g) => g.title)).toEqual(['Vision'])
  })

  it('listChildren returns direct children only, not grandchildren', async () => {
    const domain = await createGoal({ kind: 'domain', scope: 'operator', title: 'Research', createdByKind: 'founder' })
    const ai = await createGoal({
      kind: 'objective', scope: 'operator', parentId: domain.goal!.id, title: 'AI', createdByKind: 'founder',
    })
    await createGoal({
      kind: 'initiative', scope: 'operator', parentId: ai.goal!.id, title: 'Ship agent v2', createdByKind: 'founder',
    })

    const children = await listChildren(domain.goal!.id)
    expect(children.map((g) => g.title)).toEqual(['AI'])
  })
})

describe('supersession / history', () => {
  it('supersedeGoal marks the old row superseded and links it to the new one', async () => {
    const original = await makeGoal({ title: 'Old', status: 'active' })
    const { goal: replacement } = await supersedeGoal(original.id, {
      kind: 'goal', scope: 'workspace', workspaceId: 'ws-a', title: 'New', status: 'active', createdByKind: 'founder',
    })
    expect(replacement).not.toBeNull()

    const oldRow = await getGoal(original.id)
    expect(oldRow?.supersededAt).not.toBeNull()
    expect(oldRow?.supersededBy).toBe(replacement!.id)
  })

  it('a goal cannot be superseded twice', async () => {
    const original = await makeGoal({ title: 'Old' })
    await supersedeGoal(original.id, {
      kind: 'goal', scope: 'workspace', workspaceId: 'ws-a', title: 'New', createdByKind: 'founder',
    })
    const second = await supersedeGoal(original.id, {
      kind: 'goal', scope: 'workspace', workspaceId: 'ws-a', title: 'Newer', createdByKind: 'founder',
    })
    expect(second.goal).toBeNull()
    expect(second.error).toMatch(/already superseded/)
  })

  it('updateGoal refuses to mutate an already-superseded row', async () => {
    const original = await makeGoal({ title: 'Old' })
    await supersedeGoal(original.id, {
      kind: 'goal', scope: 'workspace', workspaceId: 'ws-a', title: 'New', createdByKind: 'founder',
    })
    const result = await updateGoal(original.id, { title: 'Should not apply' })
    expect(result.goal).toBeNull()
  })
})

describe('metrics / evidence', () => {
  it('recordMetric requires a source and defaults evidence_kind to authoritative', async () => {
    const goal = await makeGoal({ title: 'MRR goal' })
    const { metric, error } = await recordMetric({ goalId: goal.id, metricKey: 'mrr_usd', value: 5000, source: 'stripe' })
    expect(error).toBeUndefined()
    expect(metric?.evidenceKind).toBe('authoritative')
    expect(metric?.source).toBe('stripe')
  })

  it('an LLM-derived observation must be explicitly marked estimated, never silently authoritative', async () => {
    const goal = await makeGoal({ title: 'MRR goal' })
    const { metric } = await recordMetric({
      goalId: goal.id, metricKey: 'mrr_usd', value: 5000, source: 'llm-inference', evidenceKind: 'estimated',
    })
    expect(metric?.evidenceKind).toBe('estimated')
  })

  it('listMetrics returns newest first', async () => {
    const goal = await makeGoal({ title: 'MRR goal' })
    await recordMetric({ goalId: goal.id, metricKey: 'mrr_usd', value: 1000, source: 'stripe', observedAt: '2026-01-01T00:00:00Z' })
    await recordMetric({ goalId: goal.id, metricKey: 'mrr_usd', value: 2000, source: 'stripe', observedAt: '2026-06-01T00:00:00Z' })

    const metrics = await listMetrics(goal.id)
    expect(metrics.map((m) => m.value)).toEqual([2000, 1000])
  })
})

describe('goals do not bypass authority', () => {
  it('a goal row carries no field that grants tool/action permission — it is a plain title/status/priority/metadata record', async () => {
    const goal = await makeGoal({ title: 'Ship a risky change' })
    // Anything resembling an authority/permission grant would show up as a
    // key on the row. This is a structural check that the goal substrate
    // never grew such a field — authority stays entirely in
    // lib/caye-agent/tools/high-risk-gate.ts, untouched by this module.
    const forbiddenKeys = ['authorized', 'permission', 'grants', 'canExecute', 'authority', 'bypassGate']
    for (const key of forbiddenKeys) {
      expect(Object.prototype.hasOwnProperty.call(goal, key)).toBe(false)
    }
  })
})
