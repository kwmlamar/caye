import 'server-only'
import type { Material } from './materials'
import type { ResolvedRegion } from './geometry-regions'
import type { AnalysisConstraint, AnalysisLoad } from './spec'
import { runFeaInSandbox } from './runtime'

export type SolverInput = {
  stepBytes: Buffer
  material: Pick<Material, 'youngsModulusMpa' | 'poissonRatio' | 'densityTonnePerMm3'>
  constraints: AnalysisConstraint[]
  loads: AnalysisLoad[]
  regions: Record<string, ResolvedRegion>
}

export type NormalizedSolverResult = {
  maxVonMisesMpa: number
  maxDisplacementMm: number
  mesh: { nodeCount: number; elementCount: number; elementType: string }
  solver: string
  solverVersion: string | null
  files: { solverInput: Buffer; mesh: Buffer; solverOutput: Buffer }
}

/**
 * Adapter boundary: the application layer (../fea/analysis.ts) only ever
 * consumes NormalizedSolverResult, never CalculiX-specific formats, so a
 * future solver swap doesn't ripple outward.
 */
export interface StaticStructuralSolver {
  run(input: SolverInput): Promise<NormalizedSolverResult>
}

export class CalculixGmshSolver implements StaticStructuralSolver {
  async run(input: SolverInput): Promise<NormalizedSolverResult> {
    const generated = await runFeaInSandbox({ material: input.material, constraints: input.constraints, loads: input.loads, regions: input.regions }, input.stepBytes)
    return {
      maxVonMisesMpa: generated.results.max_von_mises_mpa,
      maxDisplacementMm: generated.results.max_displacement_mm,
      mesh: { nodeCount: generated.results.node_count, elementCount: generated.results.element_count, elementType: generated.results.element_type },
      solver: 'calculix',
      solverVersion: null,
      files: { solverInput: generated.analysisInp, mesh: generated.meshInp, solverOutput: generated.analysisFrd },
    }
  }
}
