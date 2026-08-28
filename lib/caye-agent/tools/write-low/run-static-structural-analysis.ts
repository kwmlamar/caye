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

function safeAnalysisFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return 'Structural analysis failed. No verified results were produced.'
  const message = error.message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ')
  if (message.includes('ENGINEERING_FEA_SANDBOX_IMAGE is required')) {
    return 'Structural analysis could not start because the FEA runtime is not configured. No verified results were produced.'
  }
  if (message.includes('there should not be more than 16 entries in a line')) {
    return 'CalculiX rejected the generated solver input because a node or element set line exceeded its 16-entry limit. No verified results were produced.'
  }
  if (message.includes('matched zero mesh nodes')) {
    return 'Structural analysis could not resolve one of the requested load or constraint regions on the generated mesh. No verified results were produced.'
  }
  if (message.includes('produced no usable stress/displacement rows')) {
    return 'The solver completed without producing usable stress and displacement rows. No verified results were produced.'
  }
  if (message.includes('ccx exited')) {
    return 'CalculiX failed while solving the generated analysis input. No verified results were produced.'
  }
  return 'Structural analysis failed. No verified results were produced.'
}

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
      return { ok: false, error: error instanceof EngineeringAnalysisSpecError ? error.message : safeAnalysisFailureReason(error) }
    }
  },
}
