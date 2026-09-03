import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabaseClient } from '@/lib/supabase-test-support/fake-supabase-client'

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: mocks.createServiceClient }))

import { goalsListCapability } from './goals-list'

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
  superseded_at: null,
  updated_at: '2026-08-28T00:00:00Z',
  created_at: '2026-08-01T00:00:00Z',
}

describe('goals.list capability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('scopes workspace reads structurally and excludes superseded rows', async () => {
    const client = createFakeSupabaseClient()
    client.seed('caye_goals', [row])
    mocks.createServiceClient.mockReturnValue(client)

    const result = await goalsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(client.calls('caye_goals')).toContainEqual(['is', 'superseded_at', null])
    expect(client.calls('caye_goals')).toContainEqual(['eq', 'scope', 'workspace'])
    expect(client.calls('caye_goals')).toContainEqual(['eq', 'workspace_id', 'workspace-a'])
    expect(client.calls('caye_goals')).not.toContainEqual(['eq', 'scope', 'operator'])
    expect(result.status).toBe('observed')
    expect(result.data).toEqual([expect.objectContaining({ id: 'goal-1', workspaceId: 'workspace-a' })])
    expect(result.evidence).toEqual([{ kind: 'record', id: 'goal-1' }])
  })

  it('uses operator-only scope when no workspace is active', async () => {
    const operatorRow = { ...row, id: 'vision-1', kind: 'vision', scope: 'operator', workspace_id: null }
    const client = createFakeSupabaseClient()
    client.seed('caye_goals', [operatorRow])
    mocks.createServiceClient.mockReturnValue(client)

    const result = await goalsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: null },
    })

    expect(client.calls('caye_goals')).toContainEqual(['eq', 'scope', 'operator'])
    expect(client.calls('caye_goals')).toContainEqual(['is', 'workspace_id', null])
    expect(client.calls('caye_goals')).not.toContainEqual(['eq', 'scope', 'workspace'])
    expect(result.status).toBe('observed')
  })

  it('treats zero rows as a successful observation', async () => {
    const client = createFakeSupabaseClient()
    client.seed('caye_goals', [])
    mocks.createServiceClient.mockReturnValue(client)

    const result = await goalsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(result).toMatchObject({ status: 'observed', data: [], evidence: [], failure: null })
  })

  it('fails explicitly when the database read fails', async () => {
    const client = createFakeSupabaseClient()
    client.seed('caye_goals', [], { error: { message: 'db down' } })
    mocks.createServiceClient.mockReturnValue(client)

    const result = await goalsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(result.status).toBe('failed')
    expect(result.failure).toMatchObject({ code: 'unavailable', retryable: true })
    expect(result.executionRef).toBeNull()
  })
})
