import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabaseClient } from '@/lib/supabase-test-support/fake-supabase-client'

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: mocks.createServiceClient }))

import { engineeringArtifactsListCapability } from './engineering-artifacts-list'

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

    expect(mocks.createServiceClient).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.failure).toMatchObject({ code: 'invalid_scope', retryable: false })
  })

  it('returns only workspace-scoped semantic artifact metadata with artifact evidence', async () => {
    const client = createFakeSupabaseClient()
    client.seed('engineering_artifacts', [{
      id: 'artifact-1',
      workspace_id: 'workspace-a',
      lineage_id: 'lineage-1',
      revision: 4,
      name: 'L-bracket',
      dimensions: { x: 120, y: 80, z: 40 },
      calculation_metadata: { volume_mm3: 1234 },
      parent_artifact_id: 'artifact-0',
    }])
    mocks.createServiceClient.mockReturnValue(client)

    const result = await engineeringArtifactsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(client.calls('engineering_artifacts')).toContainEqual(['eq', 'workspace_id', 'workspace-a'])
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
    const emptyClient = createFakeSupabaseClient()
    emptyClient.seed('engineering_artifacts', [])
    mocks.createServiceClient.mockReturnValueOnce(emptyClient)
    const empty = await engineeringArtifactsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })
    expect(empty).toMatchObject({ status: 'observed', data: [], evidence: [], failure: null })

    const failedClient = createFakeSupabaseClient()
    failedClient.seed('engineering_artifacts', [], { error: { message: 'db down' } })
    mocks.createServiceClient.mockReturnValueOnce(failedClient)
    const failed = await engineeringArtifactsListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })
    expect(failed.status).toBe('failed')
    expect(failed.failure).toMatchObject({ code: 'unavailable', retryable: true })
  })
})
