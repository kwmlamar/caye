import { describe, expect, it } from 'vitest'
import { EngineeringAnalysisSpecError, validateAnalysisSpec } from './spec'

const artifactSpec = { operations: ['l_bracket', 'mounting_holes'] as Array<'l_bracket' | 'mounting_holes'>, parameters: { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5 } }

const valid = {
  artifact_id: 'artifact-1',
  material_id: '6061-t6-aluminum',
  constraints: [{ type: 'fixed', region: 'rear_mounting_face' }],
  loads: [{ type: 'force', region: 'far_edge', magnitude_n: 300, direction: [0, 0, -1] }],
}

describe('FEA V1 analysis specification', () => {
  it('accepts the regression-fixture spec', () => {
    const spec = validateAnalysisSpec(valid, artifactSpec)
    expect(spec.material_id).toBe('6061-t6-aluminum')
    expect(spec.constraints).toEqual([{ type: 'fixed', region: 'rear_mounting_face' }])
    expect(spec.loads[0].magnitude_n).toBe(300)
  })
  it('rejects an unknown material as a structured clarification error', () => {
    expect(() => validateAnalysisSpec({ ...valid, material_id: 'unobtanium' }, artifactSpec)).toThrow(EngineeringAnalysisSpecError)
  })
  it('rejects an ambiguous/unsupported geometry region', () => {
    expect(() => validateAnalysisSpec({ ...valid, constraints: [{ type: 'fixed', region: 'top_face' }] }, artifactSpec)).toThrow(/could not be deterministically resolved/)
  })
  it('rejects an unsupported constraint or load type', () => {
    expect(() => validateAnalysisSpec({ ...valid, constraints: [{ type: 'pinned', region: 'rear_mounting_face' }] }, artifactSpec)).toThrow(/must be "fixed"/)
    expect(() => validateAnalysisSpec({ ...valid, loads: [{ type: 'pressure', region: 'far_edge', magnitude_n: 300, direction: [0, 0, -1] }] }, artifactSpec)).toThrow(/must be "force"/)
  })
  it.each([NaN, Infinity, -Infinity, -1, 0, 200_000])('rejects non-finite or out-of-range load magnitude (%s)', (magnitude_n) => {
    expect(() => validateAnalysisSpec({ ...valid, loads: [{ ...valid.loads[0], magnitude_n }] }, artifactSpec)).toThrow(EngineeringAnalysisSpecError)
  })
  it('rejects a malformed or zero-length direction vector', () => {
    expect(() => validateAnalysisSpec({ ...valid, loads: [{ ...valid.loads[0], direction: [0, 0] }] }, artifactSpec)).toThrow(/3-element/)
    expect(() => validateAnalysisSpec({ ...valid, loads: [{ ...valid.loads[0], direction: [0, 0, 0] }] }, artifactSpec)).toThrow(/zero-length/)
    expect(() => validateAnalysisSpec({ ...valid, loads: [{ ...valid.loads[0], direction: [NaN, 0, -1] }] }, artifactSpec)).toThrow(EngineeringAnalysisSpecError)
  })
  it('rejects empty constraints or loads', () => {
    expect(() => validateAnalysisSpec({ ...valid, constraints: [] }, artifactSpec)).toThrow(/At least one supported constraint/)
    expect(() => validateAnalysisSpec({ ...valid, loads: [] }, artifactSpec)).toThrow(/At least one supported load/)
  })
  it('rejects a code/solver-shaped payload rather than accepting it as data', () => {
    expect(() => validateAnalysisSpec({ ...valid, loads: 'DROP TABLE engineering_analyses;' }, artifactSpec)).toThrow(EngineeringAnalysisSpecError)
    expect(() => validateAnalysisSpec('*STEP\n*STATIC', artifactSpec)).toThrow(/must be an object/)
  })
})
