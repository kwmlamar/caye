import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createServiceClient } = vi.hoisted(() => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient }))

import { engineeringArtifactsListCapability } from './engineering-artifacts-list'

type QueryResult = { data: unknown[] | null; error: { message: string } | null }

function makeQuery(result: QueryResult) {
  const calls: Array<[string, ...unknown[]]> = []
  const query: Record<string, unknown> = {
    calls,
    then(resolve: (value: QueryResult) => unknown) {
      return Promise.resolve(result).then(resolve)
    },
  }
  for (const method of ['select', 'eq', 'order', 'limit'] as const) {
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

describe('engineering.artifacts.list capability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('requires an active workspace', async () => {
    const result = await engineeringArtifactsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: null },
    })

    expect(createServiceClient).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.failure).toMatchObject({ code: 'invalid_scope', retryable: false })
  })

  it('returns only workspace-scoped semantic artifact metadata with artifact evidence', async () => {
    const query = makeQuery({
      data: [{
        id: 'artifact-1',
        lineage_id: 'lineage-1',
        revision: 4,
        name: 'L-bracket',
        dimensions: { x: 120, y: 80, z: 40 },
        calculation_metadata: { volume_mm3: 1234 },
        parent_artifact_id: 'artifact-0',
      }],
      error: null,
    })
    createServiceClient.mockReturnValue({ from: vi.fn(() => query) })

    const result = await engineeringArtifactsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(query.calls).toContainEqual(['eq', 'workspace_id', 'workspace-a'])
    expect(result.status).toBe('observed')
    expect(result.data).toEqual([{
      id: 'artifact-1',
      lineageId: 'lineage-1',
      revision: 4,
      name: 'L-bracket',
      dimensions: { x: 120, y: 80, z: 40 },
      calculationMetadata: { volume_mm3: 1234 },
      parentArtifactId: 'artifact-0',
    }])
    expect(result.evidence).toEqual([{ kind: 'artifact', id: 'artifact-1' }])
  })

  it('distinguishes an empty workspace from a failed read', async () => {
    const emptyQuery = makeQuery({ data: [], error: null })
    createServiceClient.mockReturnValueOnce({ from: vi.fn(() => emptyQuery) })
    const empty = await engineeringArtifactsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })
    expect(empty).toMatchObject({ status: 'observed', data: [], evidence: [], failure: null })

    const failedQuery = makeQuery({ data: null, error: { message: 'db down' } })
    createServiceClient.mockReturnValueOnce({ from: vi.fn(() => failedQuery) })
    const failed = await engineeringArtifactsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })
    expect(failed.status).toBe('failed')
    expect(failed.failure).toMatchObject({ code: 'unavailable', retryable: true })
  })
})
