import { resolveMaterial } from './materials'
import { resolveGeometryRegion, type ArtifactSpecForRegions, type GeometryRegionName } from './geometry-regions'

export class EngineeringAnalysisSpecError extends Error {}

export type AnalysisConstraint = { type: 'fixed'; region: GeometryRegionName }
export type AnalysisLoad = { type: 'force'; region: GeometryRegionName; magnitude_n: number; direction: [number, number, number] }
export type AnalysisSpec = {
  analysis_type: 'linear_static'
  artifact_id: string
  material_id: string
  constraints: AnalysisConstraint[]
  loads: AnalysisLoad[]
}

const MAX_CONSTRAINTS = 8
const MAX_LOADS = 8
const MAX_MAGNITUDE_N = 100_000
const MIN_MAGNITUDE_N = 1e-6
const MIN_DIRECTION_LENGTH = 1e-6

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new EngineeringAnalysisSpecError(`${field} must be a finite number`)
  return value
}

function validDirection(value: unknown, field: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new EngineeringAnalysisSpecError(`${field} must be a 3-element [x, y, z] vector`)
  const [x, y, z] = value.map((v, i) => finiteNumber(v, `${field}[${i}]`))
  const length = Math.sqrt(x * x + y * y + z * z)
  if (length < MIN_DIRECTION_LENGTH) throw new EngineeringAnalysisSpecError(`${field} must not be a zero-length vector`)
  return [x, y, z]
}

/**
 * This is validation, not a best-effort parser: an unresolved material or
 * geometry region is a structured clarification error, never a guess. The
 * LLM can only reference materials/regions by name — it never supplies raw
 * geometry, solver commands, or code through this schema.
 */
export function validateAnalysisSpec(input: unknown, artifactSpec: ArtifactSpecForRegions): AnalysisSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EngineeringAnalysisSpecError('Analysis specification must be an object')
  const raw = input as Record<string, unknown>

  if (typeof raw.artifact_id !== 'string' || !raw.artifact_id) throw new EngineeringAnalysisSpecError('artifact_id is required')
  if (typeof raw.material_id !== 'string' || !resolveMaterial(raw.material_id)) {
    throw new EngineeringAnalysisSpecError(`Unknown material "${String(raw.material_id)}". Choose a material from the supported catalog.`)
  }

  if (!Array.isArray(raw.constraints) || raw.constraints.length < 1 || raw.constraints.length > MAX_CONSTRAINTS) {
    throw new EngineeringAnalysisSpecError('At least one supported constraint is required')
  }
  const constraints: AnalysisConstraint[] = raw.constraints.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new EngineeringAnalysisSpecError(`constraints[${i}] must be an object`)
    const rc = c as Record<string, unknown>
    if (rc.type !== 'fixed') throw new EngineeringAnalysisSpecError(`constraints[${i}].type must be "fixed" (V1 supports no other constraint type)`)
    const region = resolveGeometryRegion(artifactSpec, rc.region)
    if (!region) throw new EngineeringAnalysisSpecError(`constraints[${i}].region "${String(rc.region)}" could not be deterministically resolved on this artifact`)
    return { type: 'fixed', region: region.name }
  })

  if (!Array.isArray(raw.loads) || raw.loads.length < 1 || raw.loads.length > MAX_LOADS) {
    throw new EngineeringAnalysisSpecError('At least one supported load is required')
  }
  const loads: AnalysisLoad[] = raw.loads.map((l, i) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) throw new EngineeringAnalysisSpecError(`loads[${i}] must be an object`)
    const rl = l as Record<string, unknown>
    if (rl.type !== 'force') throw new EngineeringAnalysisSpecError(`loads[${i}].type must be "force" (V1 supports no other load type)`)
    const region = resolveGeometryRegion(artifactSpec, rl.region)
    if (!region) throw new EngineeringAnalysisSpecError(`loads[${i}].region "${String(rl.region)}" could not be deterministically resolved on this artifact`)
    const magnitude_n = finiteNumber(rl.magnitude_n, `loads[${i}].magnitude_n`)
    if (magnitude_n < MIN_MAGNITUDE_N || magnitude_n > MAX_MAGNITUDE_N) throw new EngineeringAnalysisSpecError(`loads[${i}].magnitude_n must be between ${MIN_MAGNITUDE_N} and ${MAX_MAGNITUDE_N} N`)
    const direction = validDirection(rl.direction, `loads[${i}].direction`)
    return { type: 'force', region: region.name, magnitude_n, direction }
  })

  return { analysis_type: 'linear_static', artifact_id: raw.artifact_id, material_id: raw.material_id, constraints, loads }
}
