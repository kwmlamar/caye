import 'server-only'
import type { Tool } from '../types'
import { validateAnalysisSpec, EngineeringAnalysisSpecError } from '@/lib/engineering/fea/spec'
import { resolveSourceArtifact, artifactSpecForRegions, runStaticStructuralAnalysis as executeStaticStructuralAnalysis } from '@/lib/engineering/fea/analysis'

type Input = {
  artifact_id: string
  material_id: string
  constraints: Array<{ type: 'fixed'; region: string }>
  loads: Array<{ type: 'force'; region: string; magnitude_n: number; direction: number[] }>
}

const SAFETY_NOTE = 'Simulation result based on modeled geometry, material properties, loads, constraints, mesh, and solver assumptions. Not structural certification.'

export const runStaticStructuralAnalysis: Tool<Input> = {
  name: 'run_static_structural_analysis',
  description: 'Run a linear static structural finite-element analysis (Gmsh mesh + CalculiX solve) against an existing engineering artifact. Returns deterministic solver-derived max stress, max displacement, and factor of safety (when yield strength is known). Constraints/loads must reference known geometry regions and a catalog material — this does not accept raw geometry, solver commands, or code. This is engineering analysis under modeled assumptions, not structural certification.',
  risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      artifact_id: { type: 'string', description: 'Engineering artifact id to analyze.' },
      material_id: { type: 'string', description: 'Material catalog id, e.g. "6061-t6-aluminum" or "a36-steel".' },
      constraints: {
        type: 'array',
        items: { type: 'object', properties: { type: { type: 'string', enum: ['fixed'] }, region: { type: 'string', description: 'e.g. rear_mounting_face, horizontal_plate, far_edge' } }, required: ['type', 'region'] },
      },
      loads: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['force'] },
            region: { type: 'string' },
            magnitude_n: { type: 'number' },
            direction: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x, y, z] direction vector, need not be normalized' },
          },
          required: ['type', 'region', 'magnitude_n', 'direction'],
        },
      },
    },
    required: ['artifact_id', 'material_id', 'constraints', 'loads'],
  },
  async execute(args, ctx) {
    if (!ctx.engineeringOrigin) return { ok: false, error: 'Structural analyses can only be run from a founder Caye Direct thread.' }
    try {
      const artifact = await resolveSourceArtifact(ctx.workspaceId, args.artifact_id)
      if (!artifact) return { ok: false, error: 'That engineering artifact was not found in this workspace.' }
      const spec = validateAnalysisSpec(args, artifactSpecForRegions(artifact))
      const analysis = await executeStaticStructuralAnalysis({
        workspaceId: ctx.workspaceId,
        threadId: ctx.engineeringOrigin.threadId,
        messageId: ctx.engineeringOrigin.messageId,
        sourceArtifact: artifact,
        materialId: spec.material_id,
        constraints: spec.constraints,
        loads: spec.loads,
      })
      ctx.engineeringAnalysisIds?.push(analysis.analysisId)
      return {
        ok: true,
        data: {
          analysis_id: analysis.analysisId,
          max_von_mises_mpa: analysis.results.max_von_mises_mpa,
          max_displacement_mm: analysis.results.max_displacement_mm,
          factor_of_safety: analysis.results.factor_of_safety,
          safety_note: SAFETY_NOTE,
        },
      }
    } catch (error) {
      return { ok: false, error: error instanceof EngineeringAnalysisSpecError ? error.message : 'Structural analysis failed. No verified results were produced.' }
    }
  },
}
