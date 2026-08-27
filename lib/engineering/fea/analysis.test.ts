import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  jobStatus: 'running' as string,
  uploadAt: -1,
  uploadCalls: [] as string[],
  removeCalls: [] as string[][],
  rpcError: null as string | null,
  rpcCalls: 0,
  rpcParams: null as null | Record<string, unknown>,
  stepMissing: false,
  stepDownloadFails: false,
  markFailedBlocked: false,
  sourceArtifactRow: { id: 'artifact-1', revision: 2, name: 'wall_bracket', parameters: { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5 } } as Record<string, unknown> | null,
  previousAnalysisRow: null as Record<string, unknown> | null,
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/engineering/fea/solver', () => ({
  CalculixGmshSolver: class {
    async run() {
      return {
        maxVonMisesMpa: 42.5,
        maxDisplacementMm: 0.31,
        mesh: { nodeCount: 5000, elementCount: 2200, elementType: 'C3D10' },
        solver: 'calculix',
        solverVersion: null,
        files: { solverInput: Buffer.from('inp'), mesh: Buffer.from('mesh'), solverOutput: Buffer.from('frd') },
      }
    }
  },
}))

/** Thenable at every step, like the real supabase-js query builder — awaiting mid-chain resolves the same as calling a terminal method. */
function queryBuilder(getResult: () => Promise<{ data: unknown; error: unknown }> | { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {
    eq: () => builder,
    in: () => builder,
    select: () => builder,
    order: () => builder,
    single: async () => getResult(),
    maybeSingle: async () => getResult(),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(getResult()).then(resolve, reject),
  }
  return builder
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'engineering_analysis_jobs') {
        return {
          insert: () => queryBuilder(() => { state.jobStatus = 'running'; return { data: { id: 'job-1' }, error: null } }),
          update: (patch: { status?: string; failure_reason?: string }) => queryBuilder(() => {
            if (patch.status === 'meshing') { state.jobStatus = 'meshing'; return { data: { id: 'job-1' }, error: null } }
            if (patch.status === 'failed') {
              if (state.markFailedBlocked) return { data: null, error: null }
              state.jobStatus = 'failed'
              return { data: { id: 'job-1' }, error: null }
            }
            return { data: null, error: null }
          }),
          select: () => queryBuilder(() => ({ data: { id: 'job-1', status: state.jobStatus }, error: null })),
        }
      }
      if (table === 'engineering_analyses') {
        return {
          select: () => queryBuilder(() => ({
            data: state.jobStatus === 'completed' ? { id: 'analysis-1', job_id: 'job-1', engineering_analysis_files: [{ kind: 'solver_input' }, { kind: 'mesh' }, { kind: 'solver_output' }, { kind: 'result_summary' }] } : null,
            error: null,
          })),
        }
      }
      if (table === 'engineering_artifact_files') {
        return { select: () => queryBuilder(() => (state.stepMissing ? { data: null, error: null } : { data: { storage_path: 'ws-1/artifact-1/part.step' }, error: null })) }
      }
      if (table === 'engineering_artifacts') {
        return { select: () => queryBuilder(() => (state.sourceArtifactRow ? { data: state.sourceArtifactRow, error: null } : { data: null, error: null })) }
      }
      throw new Error(`unexpected table in test double: ${table}`)
    },
    rpc: async (_name: string, params: Record<string, unknown>) => {
      state.rpcCalls++
      state.rpcParams = params
      if (state.rpcError) return { data: null, error: { message: state.rpcError } }
      state.jobStatus = 'completed'
      return { data: [{ out_analysis_id: 'analysis-1' }], error: null }
    },
    storage: {
      from: (bucket: string) => {
        if (bucket === 'engineering-artifacts') {
          return { download: async () => (state.stepDownloadFails ? { data: null, error: { message: 'download failed' } } : { data: { arrayBuffer: async () => new TextEncoder().encode('STEP-BYTES').buffer }, error: null }) }
        }
        return {
          upload: async (path: string) => { state.uploadCalls.push(path); return state.uploadAt === state.uploadCalls.length ? { error: { message: 'upload failed' } } : { error: null } },
          remove: async (paths: string[]) => { state.removeCalls.push(paths); return { error: null } },
        }
      },
    },
  }),
}))

import { cleanupStagedEngineeringFiles } from '../storage'
import { resolveSourceArtifact, runStaticStructuralAnalysis, loadAnalysisForRerun } from './analysis'

const sourceArtifact = { id: 'artifact-1', revision: 2, name: 'wall_bracket', parameters: { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5 } }
const runArgs = {
  workspaceId: 'ws-1',
  threadId: 'thread-1',
  messageId: 'message-1',
  sourceArtifact,
  materialId: '6061-t6-aluminum',
  constraints: [{ type: 'fixed' as const, region: 'rear_mounting_face' as const }],
  loads: [{ type: 'force' as const, region: 'far_edge' as const, magnitude_n: 300, direction: [0, 0, -1] as [number, number, number] }],
}

describe('engineering analysis finalization', () => {
  beforeEach(() => {
    state.jobStatus = 'running'
    state.uploadAt = -1
    state.uploadCalls = []
    state.removeCalls = []
    state.rpcError = null
    state.rpcCalls = 0
    state.rpcParams = null
    state.stepMissing = false
    state.stepDownloadFails = false
    state.markFailedBlocked = false
    state.sourceArtifactRow = { id: 'artifact-1', revision: 2, name: 'wall_bracket', parameters: sourceArtifact.parameters }
    state.previousAnalysisRow = null
  })

  it('a completed run persists exactly the four required files and returns finite results', async () => {
    const result = await runStaticStructuralAnalysis(runArgs)
    expect(result.analysisId).toBe('analysis-1')
    expect(result.results.max_von_mises_mpa).toBe(42.5)
    expect(result.results.max_displacement_mm).toBe(0.31)
    expect(result.results.factor_of_safety).toBeCloseTo(276 / 42.5)
    expect(state.uploadCalls).toHaveLength(4)
    expect(state.rpcCalls).toBe(1)
  })

  it('missing STEP export leaves no finalization and no discoverable analysis', async () => {
    state.stepMissing = true
    await expect(runStaticStructuralAnalysis(runArgs)).rejects.toThrow('STEP export is missing')
    expect(state.rpcCalls).toBe(0)
    expect(state.uploadCalls).toEqual([])
    expect(state.jobStatus).toBe('failed')
  })

  it('STEP download failure fails the job without ever calling the solver', async () => {
    state.stepDownloadFails = true
    await expect(runStaticStructuralAnalysis(runArgs)).rejects.toThrow('Could not download source artifact geometry')
    expect(state.rpcCalls).toBe(0)
    expect(state.jobStatus).toBe('failed')
  })

  it('a later upload failure compensates every staged object', async () => {
    state.uploadAt = 3
    await expect(runStaticStructuralAnalysis(runArgs)).rejects.toThrow('Could not stage')
    expect(state.rpcCalls).toBe(0)
    expect(state.removeCalls[0]).toHaveLength(2)
    expect(state.jobStatus).toBe('failed')
  })

  it.each(['file metadata persistence failed', 'engineering analysis finalization retry conflicts with committed analysis'])('RPC finalization failure cleans staged files (%s)', async (failure) => {
    state.rpcError = failure
    await expect(runStaticStructuralAnalysis(runArgs)).rejects.toThrow('Could not finalize')
    expect(state.removeCalls[0]).toHaveLength(4)
    expect(state.jobStatus).toBe('failed')
  })

  it('completion transition failure is never returned as success', async () => {
    state.rpcError = 'engineering analysis job is not in a runnable state'
    await expect(runStaticStructuralAnalysis(runArgs)).rejects.toThrow('Could not finalize')
    expect(state.removeCalls[0]).toHaveLength(4)
  })

  it('cleanup is idempotent', async () => {
    const calls: string[][] = []
    const storage = { remove: async (paths: string[]) => { calls.push(paths); return { error: null } } }
    await cleanupStagedEngineeringFiles(storage, ['a', 'a'])
    await cleanupStagedEngineeringFiles(storage, ['a'])
    expect(calls).toEqual([['a'], ['a']])
  })

  it('never reuses a geometry region that no longer resolves on the target artifact', async () => {
    await expect(runStaticStructuralAnalysis({ ...runArgs, sourceArtifact: { ...sourceArtifact, parameters: { width_mm: NaN, height_mm: 80, depth_mm: 40, thickness_mm: 5 } } })).rejects.toThrow(/no longer resolvable/)
    expect(state.rpcCalls).toBe(0)
  })

  it('resolveSourceArtifact never returns a foreign-workspace row', async () => {
    state.sourceArtifactRow = null
    expect(await resolveSourceArtifact('ws-1', 'artifact-1')).toBeNull()
  })

  it('loadAnalysisForRerun returns null for an unknown prior analysis', async () => {
    expect(await loadAnalysisForRerun('ws-1', 'missing-analysis')).toBeNull()
  })
})
