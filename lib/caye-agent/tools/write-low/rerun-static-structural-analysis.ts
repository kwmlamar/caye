import 'server-only'
import type { Tool } from '../types'
import { validateAnalysisSpec, EngineeringAnalysisSpecError } from '@/lib/engineering/fea/spec'
import { resolveSourceArtifact, artifactSpecForRegions, loadAnalysisForRerun, runStaticStructuralAnalysis as executeStaticStructuralAnalysis } from '@/lib/engineering/fea/analysis'

type Input = { previous_analysis_id: string; artifact_id: string }

const SAFETY_NOTE = 'Simulation result based on modeled geometry, material properties, loads, constraints, mesh, and solver assumptions. Not structural certification.'

export const rerunStaticStructuralAnalysis: Tool<Input> = {
  name: 'rerun_static_structural_analysis',
  description: 'Re-run a previously defined structural analysis (same material, constraints, and loads) against a different artifact — typically a newer revision after "make it thicker/thinner and rerun the same test." Never mutates the prior analysis. Fails closed if a stored geometry region no longer resolves on the target artifact rather than silently reinterpreting it.',
  risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      previous_analysis_id: { type: 'string', description: 'The prior analysis whose material/constraints/loads should be reused.' },
      artifact_id: { type: 'string', description: 'The artifact (typically a newer revision) to analyze with the reused setup.' },
    },
    required: ['previous_analysis_id', 'artifact_id'],
  },
  async execute(args, ctx) {
    if (!ctx.engineeringOrigin) return { ok: false, error: 'Structural analyses can only be run from a founder Caye Direct thread.' }
    try {
      const artifact = await resolveSourceArtifact(ctx.workspaceId, args.artifact_id)
      if (!artifact) return { ok: false, error: 'That engineering artifact was not found in this workspace.' }
      const previous = await loadAnalysisForRerun(ctx.workspaceId, args.previous_analysis_id)
      if (!previous) return { ok: false, error: 'That prior analysis was not found in this workspace.' }

      // Re-validated against the TARGET artifact's own geometry, not
      // trusted from the prior analysis — a region that resolved on the
      // old revision is never silently assumed to still resolve here.
      const spec = validateAnalysisSpec(
        { artifact_id: args.artifact_id, material_id: previous.materialId, constraints: previous.constraints, loads: previous.loads },
        artifactSpecForRegions(artifact)
      )
      const analysis = await executeStaticStructuralAnalysis({
        workspaceId: ctx.workspaceId,
        threadId: ctx.engineeringOrigin.threadId,
        messageId: ctx.engineeringOrigin.messageId,
        sourceArtifact: artifact,
        materialId: spec.material_id,
        constraints: spec.constraints,
        loads: spec.loads,
        previousAnalysisId: args.previous_analysis_id,
      })
      ctx.engineeringAnalysisIds?.push(analysis.analysisId)
      return {
        ok: true,
        data: {
          analysis_id: analysis.analysisId,
          previous_analysis_id: args.previous_analysis_id,
          max_von_mises_mpa: analysis.results.max_von_mises_mpa,
          max_displacement_mm: analysis.results.max_displacement_mm,
          factor_of_safety: analysis.results.factor_of_safety,
          safety_note: SAFETY_NOTE,
        },
      }
    } catch (error) {
      return { ok: false, error: error instanceof EngineeringAnalysisSpecError ? error.message : 'Structural analysis rerun failed. No verified results were produced.' }
    }
  },
}
