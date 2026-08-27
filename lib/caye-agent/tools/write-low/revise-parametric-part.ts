import 'server-only'
import type { Tool } from '../types'
import { reviseEngineeringSpec, validateEngineeringSpec, EngineeringSpecError } from '@/lib/engineering/spec'
import { createEngineeringArtifact } from '@/lib/engineering/artifacts'
import { createServiceClient } from '@/lib/supabase-server'

type Input = { artifact_id: string; thickness_mm?: number; width_mm?: number; height_mm?: number; depth_mm?: number; mounting_hole_diameter_mm?: number }
export const reviseParametricPart: Tool<Input> = {
  name: 'revise_parametric_part',
  description: 'Create an immutable next revision of a current engineering artifact by changing supported numeric parameters. Never mutates an earlier revision.',
  risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { artifact_id: { type: 'string' }, thickness_mm: { type: 'number' }, width_mm: { type: 'number' }, height_mm: { type: 'number' }, depth_mm: { type: 'number' }, mounting_hole_diameter_mm: { type: 'number' } }, required: ['artifact_id'] },
  async execute(args, ctx) {
    if (!ctx.engineeringOrigin) return { ok: false, error: 'Engineering artifacts can only be revised from a founder Caye Direct thread.' }
    try {
      const supabase = createServiceClient()
      const { data: current } = await supabase.from('engineering_artifacts').select('id, name, parameters, assumptions').eq('id', args.artifact_id).eq('workspace_id', ctx.workspaceId).maybeSingle()
      if (!current) return { ok: false, error: 'That engineering artifact was not found in this workspace.' }
      const original = validateEngineeringSpec({ type: 'parametric_part', units: 'mm', name: current.name, parameters: current.parameters, assumptions: current.assumptions, operations: ['l_bracket', 'mounting_holes'] })
      const changes = Object.fromEntries(Object.entries(args).filter(([key, value]) => key !== 'artifact_id' && value !== undefined))
      if (Object.keys(changes).length === 0) return { ok: false, error: 'Specify at least one supported dimension to revise.' }
      const spec = reviseEngineeringSpec(original, changes)
      const artifact = await createEngineeringArtifact({ workspaceId: ctx.workspaceId, threadId: ctx.engineeringOrigin.threadId, messageId: ctx.engineeringOrigin.messageId, spec, parentArtifactId: current.id, taskType: 'revise_parametric_part' })
      ctx.engineeringArtifactIds?.push(artifact.artifactId)
      return { ok: true, data: { artifact_id: artifact.artifactId, revision: artifact.revision, parent_artifact_id: current.id, safety_note: 'Geometry revised. Structural verification is not included.' } }
    } catch (error) {
      return { ok: false, error: error instanceof EngineeringSpecError ? error.message : 'Engineering revision failed. No verified geometry was produced.' }
    }
  },
}
