import 'server-only'
import type { Tool } from '../types'
import { validateEngineeringSpec, EngineeringSpecError } from '@/lib/engineering/spec'
import { createEngineeringArtifact } from '@/lib/engineering/artifacts'

type Input = { name: string; width_mm: number; height_mm: number; depth_mm: number; thickness_mm: number; mounting_hole_diameter_mm: number; assumptions?: string[] }

export const createParametricPart: Tool<Input> = {
  name: 'create_parametric_part',
  description: 'Create a constrained parametric L-shaped wall-bracket engineering artifact. Geometry and basic dimensions are generated, but this does not verify load capacity or structural safety.',
  risk: 'low', roles: ['founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: {
    name: { type: 'string', description: 'Short safe part identifier.' }, width_mm: { type: 'number' }, height_mm: { type: 'number' }, depth_mm: { type: 'number' }, thickness_mm: { type: 'number' }, mounting_hole_diameter_mm: { type: 'number' }, assumptions: { type: 'array', items: { type: 'string' } },
  }, required: ['name', 'width_mm', 'height_mm', 'depth_mm', 'thickness_mm', 'mounting_hole_diameter_mm'] },
  async execute(args, ctx) {
    if (!ctx.engineeringOrigin) return { ok: false, error: 'Engineering artifacts can only be created from a founder Caye Direct thread.' }
    try {
      const spec = validateEngineeringSpec({ type: 'parametric_part', units: 'mm', name: args.name, parameters: { ...args, mounting_hole_count: 4 }, assumptions: args.assumptions ?? [], operations: ['l_bracket', 'mounting_holes'] })
      const artifact = await createEngineeringArtifact({ workspaceId: ctx.workspaceId, threadId: ctx.engineeringOrigin.threadId, messageId: ctx.engineeringOrigin.messageId, spec, taskType: 'create_parametric_part' })
      ctx.engineeringArtifactIds?.push(artifact.artifactId)
      return { ok: true, data: { artifact_id: artifact.artifactId, revision: artifact.revision, name: artifact.name, safety_note: 'Geometry generated. Structural verification is not included.' } }
    } catch (error) {
      return { ok: false, error: error instanceof EngineeringSpecError ? error.message : 'Engineering generation failed. No verified geometry was produced.' }
    }
  },
}
