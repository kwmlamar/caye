/**
 * Deterministic, analytic geometry-region resolution for FEA.
 *
 * This intentionally does NOT touch cadquery-source.ts, runtime.ts, or the
 * CAD sandbox. The L-bracket is a fixed, known parametric template (see
 * ../cadquery-source.ts) — this module encodes the SAME geometric contract
 * in TypeScript from the artifact's already-persisted `parameters`
 * (width_mm/height_mm/depth_mm/thickness_mm), so:
 *
 *  - regions resolve for artifacts created before this feature shipped too
 *    (nothing new needs to be baked into CAD-generation metadata), and
 *  - the CAD generation pipeline is never modified by this feature, so its
 *    production-proven behavior carries zero regression risk.
 *
 * If cadquery-source.ts's template geometry ever changes, this file's
 * formulas must change with it — the cross-reference above is the seam to
 * watch, not a build-time guarantee.
 *
 * A resolved region is concrete numeric geometry (a plane point + normal +
 * bounding box + selection tolerance), never a face/edge ID — the solver
 * driver selects mesh nodes by coordinate proximity against this data. The
 * model never sees or supplies raw geometry; it only names a region.
 */

export type GeometryRegionName = 'rear_mounting_face' | 'horizontal_plate' | 'far_edge'

export const GEOMETRY_REGION_NAMES: readonly GeometryRegionName[] = ['rear_mounting_face', 'horizontal_plate', 'far_edge']

/** Only the fields this module's formulas actually read — deliberately not the full EngineeringSpec, so callers don't need to fabricate unrelated hole parameters just to resolve a region. */
export type ArtifactSpecForRegions = {
  operations: Array<'l_bracket' | 'mounting_holes'>
  parameters: { width_mm: number; height_mm: number; depth_mm: number; thickness_mm: number }
}

/** A thin axis-aligned face/volume selection window, in artifact-local mm. */
export type ResolvedRegion = {
  name: GeometryRegionName
  kind: 'face' | 'volume'
  /** Outward normal for face regions; omitted for volume regions. */
  normal?: readonly [number, number, number]
  bounds: { x: [number, number]; y: [number, number]; z: [number, number] }
  /** Node-selection tolerance in mm for the axis the region is thin along. */
  toleranceMm: number
}

const MIN_TOLERANCE_MM = 0.05

function faceTolerance(thicknessMm: number): number {
  return Math.max(MIN_TOLERANCE_MM, thicknessMm * 0.1)
}

/**
 * Returns null (never a guess) when the region name is unknown or the
 * artifact's operations aren't the known l_bracket + mounting_holes
 * template this module understands. Callers must turn a null into a
 * structured clarification error, not a silent selection.
 */
export function resolveGeometryRegion(spec: ArtifactSpecForRegions, name: unknown): ResolvedRegion | null {
  if (typeof name !== 'string' || !(GEOMETRY_REGION_NAMES as readonly string[]).includes(name)) return null
  if (!spec.operations.includes('l_bracket') || !spec.operations.includes('mounting_holes')) return null

  const { width_mm: W, height_mm: H, depth_mm: D, thickness_mm: T } = spec.parameters
  if (![W, H, D, T].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) return null

  const region = name as GeometryRegionName
  const halfW: [number, number] = [-W / 2, W / 2]
  const tol = faceTolerance(T)

  if (region === 'rear_mounting_face') {
    // Vertical plate's wall-contact face: box(W,T,H) centered=(True,True,False) -> y in [-T/2, T/2].
    return { name: region, kind: 'face', normal: [0, -1, 0], bounds: { x: halfW, y: [-T / 2, -T / 2], z: [0, H] }, toleranceMm: tol }
  }
  if (region === 'horizontal_plate') {
    // Shelf body: box(W,D,T) centered=(True,False,False) -> y in [0,D], z in [0,T].
    return { name: region, kind: 'volume', bounds: { x: halfW, y: [0, D], z: [0, T] }, toleranceMm: tol }
  }
  // far_edge: the shelf's outer end face, modeled as a thin face at y=D
  // (not a true 1-D edge) so it can be selected by coordinate proximity —
  // a documented, disclosed modeling choice for "load at the far edge."
  return { name: region, kind: 'face', normal: [0, 1, 0], bounds: { x: halfW, y: [D, D], z: [0, T] }, toleranceMm: tol }
}
