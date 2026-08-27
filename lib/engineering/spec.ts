export type EngineeringSpec = {
  type: 'parametric_part'
  units: 'mm'
  name: string
  parameters: {
    width_mm: number
    height_mm: number
    depth_mm: number
    thickness_mm: number
    mounting_hole_diameter_mm: number
    mounting_hole_count: 4
  }
  assumptions: string[]
  operations: Array<'l_bracket' | 'mounting_holes'>
}

const MAX_DIMENSION_MM = 2_000
const MIN_DIMENSION_MM = 0.1

function finiteInRange(value: unknown, field: string, min = MIN_DIMENSION_MM, max = MAX_DIMENSION_MM): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new EngineeringSpecError(`${field} must be a finite number between ${min} and ${max} mm`)
  }
  return value
}

export class EngineeringSpecError extends Error {}

/**
 * Deliberately small V1 vocabulary. This is validation, not a best-effort
 * parser: unsupported operations never become executable source.
 */
export function validateEngineeringSpec(input: unknown): EngineeringSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EngineeringSpecError('Engineering specification must be an object')
  const raw = input as Record<string, unknown>
  if (raw.type !== 'parametric_part' || raw.units !== 'mm') throw new EngineeringSpecError('Only millimetre parametric parts are supported')
  if (typeof raw.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(raw.name)) throw new EngineeringSpecError('name must be a short safe identifier')
  const params = raw.parameters
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new EngineeringSpecError('parameters are required')
  const p = params as Record<string, unknown>
  const operations = raw.operations
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 2 || operations.some((op) => op !== 'l_bracket' && op !== 'mounting_holes')) {
    throw new EngineeringSpecError('Only l_bracket and mounting_holes operations are supported')
  }
  if (!operations.includes('l_bracket') || !operations.includes('mounting_holes')) throw new EngineeringSpecError('A V1 wall bracket requires l_bracket and mounting_holes')
  const width = finiteInRange(p.width_mm, 'width_mm')
  const height = finiteInRange(p.height_mm, 'height_mm')
  const depth = finiteInRange(p.depth_mm, 'depth_mm')
  const thickness = finiteInRange(p.thickness_mm, 'thickness_mm')
  const hole = finiteInRange(p.mounting_hole_diameter_mm, 'mounting_hole_diameter_mm')
  if (thickness >= Math.min(height, depth) / 2) throw new EngineeringSpecError('thickness_mm is too large for the bracket dimensions')
  if (hole >= Math.min(width, height) / 2) throw new EngineeringSpecError('mounting_hole_diameter_mm is too large for the bracket dimensions')
  if (p.mounting_hole_count !== 4) throw new EngineeringSpecError('V1 supports exactly four mounting holes')
  const assumptions = Array.isArray(raw.assumptions) && raw.assumptions.every((a) => typeof a === 'string' && a.length <= 400)
    ? raw.assumptions.map((a) => a.trim()).filter(Boolean).slice(0, 12)
    : []
  return {
    type: 'parametric_part', units: 'mm', name: raw.name,
    parameters: { width_mm: width, height_mm: height, depth_mm: depth, thickness_mm: thickness, mounting_hole_diameter_mm: hole, mounting_hole_count: 4 },
    assumptions, operations: ['l_bracket', 'mounting_holes'],
  }
}

export function reviseEngineeringSpec(spec: EngineeringSpec, changes: Partial<EngineeringSpec['parameters']>): EngineeringSpec {
  return validateEngineeringSpec({ ...spec, parameters: { ...spec.parameters, ...changes } })
}
