import type { Material } from './materials'
import type { ResolvedRegion } from './geometry-regions'
import type { AnalysisConstraint, AnalysisLoad } from './spec'

export type DriverInput = {
  material: Pick<Material, 'youngsModulusMpa' | 'poissonRatio' | 'densityTonnePerMm3'>
  constraints: AnalysisConstraint[]
  loads: AnalysisLoad[]
  /** Every region referenced by constraints/loads, resolved to concrete numeric geometry — never a face/edge ID. */
  regions: Record<string, ResolvedRegion>
}

function pyFloat(n: number): string {
  if (!Number.isFinite(n)) throw new Error('non-finite value cannot be embedded in the FEA driver script')
  return n.toExponential(10)
}

function pyBoundsTuple(region: ResolvedRegion): string {
  const { x, y, z } = region.bounds
  return `((${pyFloat(x[0])}, ${pyFloat(x[1])}), (${pyFloat(y[0])}, ${pyFloat(y[1])}), (${pyFloat(z[0])}, ${pyFloat(z[1])}))`
}

/**
 * Source is entirely Caye-owned; every embedded value is a pre-validated
 * finite number or a fixed enum string produced by our own spec/geometry-
 * region resolution (../fea/spec.ts, ../fea/geometry-regions.ts) — never
 * model-authored text, code, or a raw face/edge ID. Mirrors the trust
 * model of ../cadquery-source.ts exactly.
 *
 * Pipeline (all in one process, matching CAD's single-script pattern):
 *   1. Gmsh loads the artifact's STEP export and generates a second-order
 *      (quadratic) tetrahedral volume mesh — linear tets are known to be
 *      overly stiff for thin, bending-dominated parts like this bracket.
 *   2. Node sets for every referenced region are selected by coordinate
 *      proximity against the resolved bounds/tolerance (never by gmsh's own
 *      face/edge numbering, which is not guaranteed stable).
 *   3. The raw mesh (nodes + elements) is written as mesh.inp.
 *   4. A full CalculiX deck (material, boundary fixity, distributed nodal
 *      loads, static step, node/element print requests) is assembled and
 *      written as analysis.inp.
 *   5. ccx runs the deck; the .dat text output is parsed and von Mises
 *      stress is computed from the raw 6-component tensor (CalculiX does
 *      not emit a von Mises scalar itself — every FEA post-processor
 *      derives it the same way from S11/S22/S33/S12/S13/S23).
 *   6. Finite-value-validated results.json is emitted, mirroring
 *      ../cadquery-source.ts's metadata.json contract.
 *
 * Load modeling assumption (disclosed in the persisted disclaimer): a
 * region's total force is distributed as an EQUAL nodal force across every
 * selected node — a standard, simple approximation for a load "at" a
 * region, not a certified pressure/traction distribution.
 */
export function feaDriverSource(input: DriverInput): string {
  const E = pyFloat(input.material.youngsModulusMpa)
  const NU = pyFloat(input.material.poissonRatio)
  const RHO = pyFloat(input.material.densityTonnePerMm3)

  const regionsPy = Object.entries(input.regions)
    .map(([name, region]) => `    ${JSON.stringify(name)}: {'bounds': ${pyBoundsTuple(region)}, 'tol': ${pyFloat(region.toleranceMm)}},`)
    .join('\n')

  const constraintsPy = input.constraints
    .map((c, i) => `    {'index': ${i}, 'region': ${JSON.stringify(c.region)}},`)
    .join('\n')

  const loadsPy = input.loads
    .map((l, i) => `    {'index': ${i}, 'region': ${JSON.stringify(l.region)}, 'magnitude_n': ${pyFloat(l.magnitude_n)}, 'direction': (${l.direction.map(pyFloat).join(', ')})},`)
    .join('\n')

  return String.raw`import gmsh
import json
import re
import subprocess
import sys

E_MPA = ${E}
NU = ${NU}
RHO_TONNE_MM3 = ${RHO}

REGIONS = {
${regionsPy}
}
CONSTRAINTS = [
${constraintsPy}
]
LOADS = [
${loadsPy}
]

def fail(stage, message):
    print(f"FEA_FAILURE stage={stage} message={message}", file=sys.stderr)
    sys.exit(1)

def in_bounds(pt, bounds, tol):
    x, y, z = pt
    (x0, x1), (y0, y1), (z0, z1) = bounds
    return (x0 - tol) <= x <= (x1 + tol) and (y0 - tol) <= y <= (y1 + tol) and (z0 - tol) <= z <= (z1 + tol)

def append_id_set(deck, keyword, ids):
    deck.append(keyword + '\n')
    for start in range(0, len(ids), 16):
        deck.append(','.join(str(i) for i in ids[start:start + 16]) + '\n')

gmsh.initialize()
gmsh.option.setNumber('General.Terminal', 0)
gmsh.model.add('part')
try:
    gmsh.merge('part.step')
except Exception as e:
    fail('step_import', str(e))

gmsh.option.setNumber('Mesh.ElementOrder', 2)
gmsh.option.setNumber('Mesh.HighOrderOptimize', 1)
try:
    gmsh.model.mesh.generate(3)
except Exception as e:
    fail('mesh_generate', str(e))

node_tags, coords, _ = gmsh.model.mesh.getNodes()
node_tags = [int(t) for t in node_tags]
node_count = len(node_tags)
if node_count == 0:
    fail('mesh_generate', 'no nodes produced')
points = [(coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]) for i in range(node_count)]

elem_types, elem_tags_by_type, _ = gmsh.model.mesh.getElements(3)
all_element_ids = [int(t) for tags in elem_tags_by_type for t in tags]
element_count = len(all_element_ids)
if element_count == 0:
    fail('mesh_generate', 'no volume elements produced')

node_sets = {}
for name, region in REGIONS.items():
    ids = [tag for tag, pt in zip(node_tags, points) if in_bounds(pt, region['bounds'], region['tol'])]
    if len(ids) == 0:
        fail('region_selection', f'region {name} matched zero mesh nodes')
    node_sets[name] = ids

gmsh.write('mesh.inp')
gmsh.finalize()

with open('mesh.inp') as f:
    mesh_text = f.read()

deck = [mesh_text]
append_id_set(deck, '*ELSET, ELSET=EALL', all_element_ids)
for name, ids in node_sets.items():
    append_id_set(deck, f'*NSET, NSET={name.upper()}', ids)
append_id_set(deck, '*NSET, NSET=NALL', node_tags)

deck.append("*MATERIAL, NAME=MAT1\n*ELASTIC\n")
deck.append(f"{E_MPA}, {NU}\n*DENSITY\n{RHO_TONNE_MM3}\n")
deck.append("*SOLID SECTION, ELSET=EALL, MATERIAL=MAT1\n")

for c in CONSTRAINTS:
    deck.append(f"*BOUNDARY\n{c['region'].upper()}, 1, 3\n")

deck.append("*STEP\n*STATIC\n")
for l in LOADS:
    ids = node_sets[l['region']]
    per_node = l['magnitude_n'] / len(ids)
    fx, fy, fz = l['direction']
    deck.append("*CLOAD\n")
    for node_id in ids:
        if abs(fx) > 1e-12:
            deck.append(f"{node_id}, 1, {per_node * fx}\n")
        if abs(fy) > 1e-12:
            deck.append(f"{node_id}, 2, {per_node * fy}\n")
        if abs(fz) > 1e-12:
            deck.append(f"{node_id}, 3, {per_node * fz}\n")
deck.append("*NODE PRINT, NSET=NALL\nU\n")
deck.append("*EL PRINT, ELSET=EALL\nS\n")
deck.append("*NODE FILE\nU\n")
deck.append("*EL FILE\nS\n")
deck.append("*END STEP\n")

with open('analysis.inp', 'w') as f:
    f.write(''.join(deck))

proc = subprocess.run(['ccx', 'analysis'], capture_output=True, text=True, timeout=200)
if proc.returncode != 0:
    fail('solve', f'ccx exited {proc.returncode}: {(proc.stderr or proc.stdout)[:1500]}')

try:
    with open('analysis.dat') as f:
        dat_text = f.read()
except FileNotFoundError:
    fail('solve', 'ccx produced no .dat output')

max_mises = 0.0
mises_row = re.compile(r'^\s*\d+\s+\d+((?:\s+-?\d+\.?\d*(?:[eE][+-]?\d+)?){6})\s*$')
for line in dat_text.splitlines():
    m = mises_row.match(line)
    if not m:
        continue
    s11, s22, s33, s12, s13, s23 = (float(v) for v in m.group(1).split())
    vm = (0.5 * ((s11 - s22) ** 2 + (s22 - s33) ** 2 + (s33 - s11) ** 2) + 3 * (s12 ** 2 + s13 ** 2 + s23 ** 2)) ** 0.5
    if vm > max_mises:
        max_mises = vm

max_disp = 0.0
disp_row = re.compile(r'^\s*\d+((?:\s+-?\d+\.?\d*(?:[eE][+-]?\d+)?){3})\s*$')
for line in dat_text.splitlines():
    m = disp_row.match(line)
    if not m:
        continue
    u1, u2, u3 = (float(v) for v in m.group(1).split())
    mag = (u1 ** 2 + u2 ** 2 + u3 ** 2) ** 0.5
    if mag > max_disp:
        max_disp = mag

if max_mises <= 0.0 or max_disp <= 0.0:
    fail('result_parse', 'solver produced no usable stress/displacement rows')

with open('results.json', 'w') as f:
    json.dump({
        'max_von_mises_mpa': max_mises,
        'max_displacement_mm': max_disp,
        'node_count': node_count,
        'element_count': element_count,
        'element_type': 'C3D10',
    }, f)
`
}
