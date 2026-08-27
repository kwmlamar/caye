import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

import { createFakeGoalsClient } from './test-support/fake-goals-db'

let fake = createFakeGoalsClient()

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => fake.client,
}))

const { seedStarterDirection } = await import('./seed')
const { listOperatorScopeGoals } = await import('./goals')

beforeEach(() => {
  fake = createFakeGoalsClient()
})

describe('seedStarterDirection', () => {
  it('creates exactly one operator-scope vision plus its domains/objectives', async () => {
    const result = await seedStarterDirection('founder-1')
    expect(result.created).toBe(true)

    const goals = await listOperatorScopeGoals()
    const visions = goals.filter((g) => g.kind === 'vision')
    expect(visions.length).toBe(1)
    // Every seeded row must be operator-scope only — the seed never touches
    // a customer workspace.
    expect(goals.every((g) => g.scope === 'operator' && g.workspaceId === null)).toBe(true)
  })

  it('is idempotent — calling it again does not create a second vision or duplicate domains', async () => {
    await seedStarterDirection('founder-1')
    const second = await seedStarterDirection('founder-1')
    expect(second.created).toBe(false)

    const goals = await listOperatorScopeGoals()
    expect(goals.filter((g) => g.kind === 'vision').length).toBe(1)
    expect(goals.filter((g) => g.kind === 'domain').length).toBe(3)
  })

  it('records real provenance — the founder who triggered it, not a hardcoded identity', async () => {
    await seedStarterDirection('founder-42')
    const goals = await listOperatorScopeGoals()
    expect(goals.every((g) => g.createdByUserId === 'founder-42')).toBe(true)
    expect(goals.every((g) => g.createdByKind === 'founder')).toBe(true)
  })
})
