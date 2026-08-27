import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ uploadAt: -1, uploadCalls: [] as string[], removeCalls: [] as string[][], rpcError: null as string | null, completionFailure: false, rpcCalls: 0, parent: null as null | Record<string, unknown>, rpcParams: null as null | Record<string, unknown> }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/engineering/runtime', () => ({ generateCadInSandbox: vi.fn(async () => ({ source: 'source', stl: Buffer.from('stl'), step: Buffer.from('step'), metadata: { bounds_mm: { x: 120, y: 40, z: 80 }, volume_mm3: 10_000 } })) }))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => {
  const jobs = {
    insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'job-1' }, error: null }) }) }),
    update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => state.completionFailure ? { data: null, error: null } : { data: { id: 'job-1' }, error: null } }) }) }) }),
  }
  return {
    from: (table: string) => table === 'engineering_jobs' ? jobs : { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.parent, error: null }) }) }) }) },
    rpc: async (_name: string, params: Record<string, unknown>) => { state.rpcCalls++; state.rpcParams = params; return state.rpcError ? { data: null, error: { message: state.rpcError } } : { data: [{ artifact_id: 'artifact-1', revision: 1 }], error: null } },
    storage: { from: () => ({
      upload: async (path: string) => { state.uploadCalls.push(path); return state.uploadAt === state.uploadCalls.length ? { error: { message: 'upload failed' } } : { error: null } },
      remove: async (paths: string[]) => { state.removeCalls.push(paths); return { error: null } },
    }) },
  }
} }))

import { cleanupStagedEngineeringFiles, createEngineeringArtifact } from './artifacts'

const spec = { type: 'parametric_part' as const, units: 'mm' as const, name: 'wall_bracket', parameters: { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5, mounting_hole_diameter_mm: 6, mounting_hole_count: 4 as const }, assumptions: [], operations: ['l_bracket', 'mounting_holes'] as Array<'l_bracket' | 'mounting_holes'> }
const args = { workspaceId: 'ws-1', threadId: 'thread-1', messageId: 'message-1', spec, taskType: 'create_parametric_part' as const }

describe('engineering artifact finalization', () => {
  beforeEach(() => { state.uploadAt = -1; state.uploadCalls = []; state.removeCalls = []; state.rpcError = null; state.completionFailure = false; state.rpcCalls = 0; state.parent = null; state.rpcParams = null })
  it('first upload failure leaves no finalization and no discoverable artifact', async () => {
    state.uploadAt = 1
    await expect(createEngineeringArtifact(args)).rejects.toThrow('Could not stage')
    expect(state.rpcCalls).toBe(0); expect(state.removeCalls).toEqual([])
  })
  it('later upload failure compensates every staged object', async () => {
    state.uploadAt = 3
    await expect(createEngineeringArtifact(args)).rejects.toThrow('Could not stage')
    expect(state.rpcCalls).toBe(0); expect(state.removeCalls[0]).toHaveLength(2)
  })
  it.each(['file metadata persistence failed', 'artifact finalization failed'])('RPC finalization failure cleans staged files (%s)', async (failure) => {
    state.rpcError = failure
    await expect(createEngineeringArtifact(args)).rejects.toThrow('Could not finalize')
    expect(state.removeCalls[0]).toHaveLength(4)
  })
  it('completion transition failure is never returned as success', async () => {
    state.rpcError = 'engineering job is not running'
    await expect(createEngineeringArtifact(args)).rejects.toThrow('Could not finalize')
    expect(state.removeCalls[0]).toHaveLength(4)
  })
  it('cleanup is idempotent', async () => {
    const storage = { remove: async (paths: string[]) => { state.removeCalls.push(paths); return { error: null } } }
    await cleanupStagedEngineeringFiles(storage, ['a', 'a']); await cleanupStagedEngineeringFiles(storage, ['a'])
    expect(state.removeCalls).toEqual([['a'], ['a']])
  })
  it('keeps a revision in its parent lineage, independent of display name', async () => {
    state.parent = { id: 'parent-1', lineage_id: 'lineage-a', revision: 1, name: 'wall_bracket', parameters: spec.parameters, assumptions: [] }
    await createEngineeringArtifact({ ...args, parentArtifactId: 'parent-1', taskType: 'revise_parametric_part' })
    expect(state.rpcParams).toMatchObject({ p_parent_artifact_id: 'parent-1', p_lineage_id: 'lineage-a' })
  })
  it('conflicting concurrent revision finalization fails without a discoverable artifact', async () => {
    state.parent = { id: 'parent-1', lineage_id: 'lineage-a', revision: 1, name: 'wall_bracket', parameters: spec.parameters, assumptions: [] }
    state.rpcError = 'engineering revision parent is no longer current'
    await expect(createEngineeringArtifact({ ...args, parentArtifactId: 'parent-1', taskType: 'revise_parametric_part' })).rejects.toThrow('Could not finalize')
    expect(state.removeCalls[0]).toHaveLength(4)
  })
})
