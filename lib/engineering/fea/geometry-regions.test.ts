import { describe, expect, it } from 'vitest'
import { resolveGeometryRegion } from './geometry-regions'

const bracket = { operations: ['l_bracket', 'mounting_holes'] as Array<'l_bracket' | 'mounting_holes'>, parameters: { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5 } }

describe('FEA geometry region resolution', () => {
  it('resolves the rear mounting face to the vertical plate wall-contact plane', () => {
    const region = resolveGeometryRegion(bracket, 'rear_mounting_face')
    expect(region?.kind).toBe('face')
    expect(region?.bounds.y).toEqual([-2.5, -2.5])
    expect(region?.bounds.x).toEqual([-60, 60])
    expect(region?.bounds.z).toEqual([0, 80])
    expect(region?.normal).toEqual([0, -1, 0])
  })
  it('resolves far_edge to the shelf outer end face', () => {
    const region = resolveGeometryRegion(bracket, 'far_edge')
    expect(region?.bounds.y).toEqual([40, 40])
    expect(region?.bounds.z).toEqual([0, 5])
  })
  it('resolves horizontal_plate as a volume region', () => {
    const region = resolveGeometryRegion(bracket, 'horizontal_plate')
    expect(region?.kind).toBe('volume')
    expect(region?.bounds.y).toEqual([0, 40])
  })
  it.each(['top_face', 'left_edge', '', 'rear_mounting_face; drop table x'])('never guesses: returns null for an unsupported region name (%s)', (name) => {
    expect(resolveGeometryRegion(bracket, name)).toBeNull()
  })
  it('fails closed for an artifact whose operations are not the known template', () => {
    expect(resolveGeometryRegion({ ...bracket, operations: ['l_bracket'] }, 'rear_mounting_face')).toBeNull()
  })
  it('fails closed for non-finite or missing parameters', () => {
    expect(resolveGeometryRegion({ ...bracket, parameters: { ...bracket.parameters, width_mm: NaN } }, 'rear_mounting_face')).toBeNull()
  })
})
