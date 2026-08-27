import { describe, expect, it } from 'vitest'
import { feaDriverSource } from './driver-source'
import { resolveGeometryRegion } from './geometry-regions'

const artifactSpec = { operations: ['l_bracket', 'mounting_holes'] as Array<'l_bracket' | 'mounting_holes'>, parameters: { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5 } }
const rear = resolveGeometryRegion(artifactSpec, 'rear_mounting_face')!
const far = resolveGeometryRegion(artifactSpec, 'far_edge')!

const input = {
  material: { youngsModulusMpa: 68_900, poissonRatio: 0.33, densityTonnePerMm3: 2.7e-9 },
  constraints: [{ type: 'fixed' as const, region: 'rear_mounting_face' as const }],
  loads: [{ type: 'force' as const, region: 'far_edge' as const, magnitude_n: 300, direction: [0, 0, -1] as [number, number, number] }],
  regions: { rear_mounting_face: rear, far_edge: far },
}

describe('FEA driver script generation', () => {
  it('embeds every validated numeric value from the resolved spec', () => {
    const source = feaDriverSource(input)
    expect(source).toContain('gmsh.merge')
    expect(source).toContain("['ccx', 'analysis']")
    expect(source).toContain('E_MPA = 6.8900000000e+4')
    expect(source).toContain('"rear_mounting_face"')
    expect(source).toContain('"far_edge"')
    expect(source).toContain('magnitude_n')
    expect(source).toContain('*BOUNDARY')
    expect(source).toContain('*CLOAD')
    expect(source).toContain('*NODE PRINT')
    expect(source).toContain('*EL PRINT')
    // The two regex/f-string escape classes that broke silently under a
    // non-raw template literal (see feaDriverSource's String.raw comment):
    // \s\d escapes must survive intact for CalculiX .dat parsing, and \n
    // inside an f-string must stay a literal two-character escape rather
    // than becoming a real newline that splits the Python string literal.
    expect(source).toContain(String.raw`\s*\d+\s+\d+`)
    expect(source).toContain(String.raw`f"*ELSET, ELSET=EALL\n"`)
  })
  it('never emits raw face/edge IDs — regions are numeric bounds, selected by coordinate proximity', () => {
    const source = feaDriverSource(input)
    expect(source).toContain('in_bounds(pt, region')
    expect(source).not.toMatch(/face_id|edge_id|getBoundingBox\(\)\.faces/i)
  })
  it('refuses to embed a non-finite value rather than silently emitting NaN into the script', () => {
    const withNonFinite = { ...input, loads: [{ ...input.loads[0], magnitude_n: NaN }] }
    expect(() => feaDriverSource(withNonFinite)).toThrow(/non-finite/)
  })
  it('only emits the regions actually referenced by constraints/loads', () => {
    const onlyRear = { ...input, loads: [] as typeof input.loads, regions: { rear_mounting_face: rear } }
    const source = feaDriverSource(onlyRear)
    expect(source).toContain('"rear_mounting_face"')
    expect(source).not.toContain('"far_edge"')
  })
})
