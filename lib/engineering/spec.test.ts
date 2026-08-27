import { describe, expect, it } from 'vitest'
import { EngineeringSpecError, reviseEngineeringSpec, validateEngineeringSpec } from './spec'

const valid = { type: 'parametric_part', units: 'mm', name: 'wall_bracket', parameters: { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5, mounting_hole_diameter_mm: 6, mounting_hole_count: 4 }, assumptions: [], operations: ['l_bracket', 'mounting_holes'] }

describe('engineering V1 specification', () => {
  it('accepts the constrained wall-bracket family', () => expect(validateEngineeringSpec(valid).parameters.thickness_mm).toBe(5))
  it.each([NaN, Infinity, -Infinity, 0, 2001])('rejects non-finite or out-of-range dimensions (%s)', (value) => {
    expect(() => validateEngineeringSpec({ ...valid, parameters: { ...valid.parameters, width_mm: value } })).toThrow(EngineeringSpecError)
  })
  it('rejects unsupported operations and arbitrary-code-shaped input', () => {
    expect(() => validateEngineeringSpec({ ...valid, operations: ['l_bracket', 'shell_exec'] })).toThrow('Only l_bracket')
    expect(() => validateEngineeringSpec({ ...valid, name: 'bracket;rm-rf' })).toThrow('safe identifier')
  })
  it('creates a validated immutable revision rather than modifying its input', () => {
    const original = validateEngineeringSpec(valid); const revision = reviseEngineeringSpec(original, { thickness_mm: 4 })
    expect(original.parameters.thickness_mm).toBe(5); expect(revision.parameters.thickness_mm).toBe(4)
  })
})
