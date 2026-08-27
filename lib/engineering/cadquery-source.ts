import 'server-only'
import type { EngineeringSpec } from './spec'

/** Source is entirely Caye-owned; values are serialized validated numbers. */
export function cadQuerySource(spec: EngineeringSpec): string {
  const p = spec.parameters
  return `import cadquery as cq\nfrom pathlib import Path\nimport json\n\nW=${p.width_mm}\nH=${p.height_mm}\nD=${p.depth_mm}\nT=${p.thickness_mm}\nHOLE=${p.mounting_hole_diameter_mm}\n# Fixed V1 L-bracket template; this file receives no model-authored code.\nvertical = cq.Workplane('XY').box(W, T, H, centered=(True, True, False))\nhorizontal = cq.Workplane('XY').box(W, D, T, centered=(True, False, False))\npart = vertical.union(horizontal)\nfor x in (-W * 0.3, W * 0.3):\n    for z in (H * 0.3, H * 0.7):\n        part = part.cut(cq.Workplane('XZ').center(x, z).circle(HOLE / 2).extrude(T * 3, both=True))\ncq.exporters.export(part, 'part.stl')\ncq.exporters.export(part, 'part.step')\nbb = part.val().BoundingBox()\nPath('metadata.json').write_text(json.dumps({'bounds_mm': {'x': bb.xlen, 'y': bb.ylen, 'z': bb.zlen}, 'volume_mm3': part.val().Volume()}))\n`
}
