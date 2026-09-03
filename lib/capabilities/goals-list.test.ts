import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createServiceClient } = vi.hoisted(() => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient }))

import { goalsListCapability } from './goals-list'

function queryResult(result: { data: unknown[] | null; error: { message: string } | null }) {
  const calls: Array<[string, ...unknown[]]> = []
  const query: Record<string, unknown> = {
    calls,
    from: vi.fn(),
    select: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
    eq: vi.fn(),
    then(resolve: (value: typeof result) => unknown) {
      return Promise.resolve(result).then(resolve)
    },
  }
  for (const method of ['select', 'is', 'order', 'eq'] as const) {
    query[method] = vi.fn((...args: unknown[]) => {
      calls.push([method, ...args])
      return query
    })
  }
  return query
}

const baseContext = {
  actor: { kind: 'founder' as const, userId: 'founder-1' },
  caller: 'external_reasoner' as const,
}

const row = {
  id: 'goal-1',
  kind: 'goal',
  parent_id: null,
  scope: 'workspace',
  workspace_id: 'workspace-a',
  title: 'Grow revenue',
  description: null,
  status: 'active',
  priority: 'high',
  target_value: 20000,
  current_value: 5000,
  unit: 'USD MRR',
  target_date: null,
  confidence: 0.8,
  completion_criteria: 'Reach target',
  updated_at: '2026-08-28T00:00:00Z',
}

describe('goals.list capability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('scopes workspace reads structurally and excludes superseded rows', async () => {
    const query = queryResult({ data: [row], error: null })
    createServiceClient.mockReturnValue({ from: vi.fn(() => query) })

    const result = await goalsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(query.calls).toContainEqual(['is', 'superseded_at', null])
    expect(query.calls).toContainEqual(['eq', 'scope', 'workspace'])
    expect(query.calls).toContainEqual(['eq', 'workspace_id', 'workspace-a'])
    expect(query.calls).not.toContainEqual(['eq', 'scope', 'operator'])
    expect(result.status).toBe('observed')
    expect(result.data).toEqual([expect.objectContaining({ id: 'goal-1', workspaceId: 'workspace-a' })])
    expect(result.evidence).toEqual([{ kind: 'record', id: 'goal-1' }])
  })

  it('uses operator-only scope when no workspace is active', async () => {
    const operatorRow = { ...row, id: 'vision-1', kind: 'vision', scope: 'operator', workspace_id: null }
    const query = queryResult({ data: [operatorRow], error: null })
    createServiceClient.mockReturnValue({ from: vi.fn(() => query) })

    const result = await goalsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: null },
    })

    expect(query.calls).toContainEqual(['eq', 'scope', 'operator'])
    expect(query.calls).toContainEqual(['is', 'workspace_id', null])
    expect(query.calls).not.toContainEqual(['eq', 'scope', 'workspace'])
    expect(result.status).toBe('observed')
  })

  it('treats zero rows as a successful observation', async () => {
    const query = queryResult({ data: [], error: null })
    createServiceClient.mockReturnValue({ from: vi.fn(() => query) })

    const result = await goalsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(result).toMatchObject({ status: 'observed', data: [], evidence: [], failure: null })
  })

  it('fails explicitly when the database read fails', async () => {
    const query = queryResult({ data: null, error: { message: 'db down' } })
    createServiceClient.mockReturnValue({ from: vi.fn(() => query) })

    const result = await goalsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(result.status).toBe('failed')
    expect(result.failure).toMatchObject({ code: 'unavailable', retryable: true })
    expect(result.executionRef).toBeNull()
  })
})
