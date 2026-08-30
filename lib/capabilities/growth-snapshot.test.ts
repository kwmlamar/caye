import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: mocks.createServiceClient }))

import { growthSnapshotCapability } from './growth-snapshot'

function query(data: unknown[] = [], error: unknown = null) {
  const api: any = {
    select: vi.fn(() => api),
    eq: vi.fn(() => api),
    is: vi.fn(() => api),
    order: vi.fn(() => api),
    limit: vi.fn(async () => ({ data, error })),
    then: (resolve: (value: unknown) => unknown) => resolve({ data, error }),
  }
  return api
}

const context = (workspaceId: string | null) => ({
  actor: { kind: 'founder' as const, userId: 'founder' },
  scope: { workspaceId },
  caller: 'external_reasoner' as const,
})

describe('growth.snapshot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fails closed without workspace scope', async () => {
    const result = await growthSnapshotCapability.execute({}, context(null))
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'invalid_scope' } })
    expect(mocks.createServiceClient).not.toHaveBeenCalled()
  })

  it('reports disconnected analytics as unavailable rather than zero traffic', async () => {
    const byTable: Record<string, any> = {
      growth_sources: query([{ provider: 'ga4', status: 'disconnected', last_success_at: null, last_error_at: null, last_error_code: null }]),
      growth_observations: query([]),
      growth_diagnoses: query([]),
      growth_recommendations: query([]),
    }
    mocks.createServiceClient.mockReturnValue({ from: (table: string) => byTable[table] })

    const result = await growthSnapshotCapability.execute({}, context('workspace-a'))
    expect(result.status).toBe('observed')
    if (result.status === 'failed') throw new Error('unexpected')
    expect(result.data?.coverage.unavailableSources).toEqual(['ga4'])
    expect(result.data?.observations).toEqual([])
    expect(JSON.stringify(result.data)).not.toContain('"metricValue":0')
  })

  it('never crosses an execution boundary', async () => {
    const q = query([])
    mocks.createServiceClient.mockReturnValue({ from: () => q })
    const result = await growthSnapshotCapability.execute({}, context('workspace-a'))
    expect(result.executionRef).toBeNull()
  })
})
