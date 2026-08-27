import 'server-only'
import { Sandbox } from '@vercel/sandbox'
import { feaDriverSource, type DriverInput } from './driver-source'

// Longer than CAD's 90s (../runtime.ts): meshing + a real linear solve
// needs more headroom. ccx itself is bounded to 200s inside the driver
// script, leaving margin for gmsh meshing and file I/O within this budget.
const TIMEOUT_MS = 240_000
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024
const MAX_RESULT_JSON_BYTES = 128 * 1024
const MAX_DIAGNOSTIC_CHARS = 2_000

export type GeneratedFeaFiles = {
  driverSource: string
  meshInp: Buffer
  analysisInp: Buffer
  analysisFrd: Buffer
  results: { max_von_mises_mpa: number; max_displacement_mm: number; node_count: number; element_count: number; element_type: string }
}

function safeDiagnostic(value: unknown): string {
  const raw = value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, MAX_DIAGNOSTIC_CHARS)
}

function validateResults(input: unknown): GeneratedFeaFiles['results'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('FEA runtime emitted invalid results')
  const raw = input as Record<string, unknown>
  const mises = raw.max_von_mises_mpa
  const disp = raw.max_displacement_mm
  const nodeCount = raw.node_count
  const elementCount = raw.element_count
  if (typeof mises !== 'number' || !Number.isFinite(mises) || mises <= 0 || mises > 1_000_000) throw new Error('FEA runtime emitted invalid max von Mises stress')
  if (typeof disp !== 'number' || !Number.isFinite(disp) || disp <= 0 || disp > 10_000) throw new Error('FEA runtime emitted invalid max displacement')
  if (typeof nodeCount !== 'number' || !Number.isInteger(nodeCount) || nodeCount <= 0) throw new Error('FEA runtime emitted invalid node count')
  if (typeof elementCount !== 'number' || !Number.isInteger(elementCount) || elementCount <= 0) throw new Error('FEA runtime emitted invalid element count')
  if (typeof raw.element_type !== 'string' || !raw.element_type) throw new Error('FEA runtime emitted invalid element type')
  return { max_von_mises_mpa: mises, max_displacement_mm: disp, node_count: nodeCount, element_count: elementCount, element_type: raw.element_type }
}

/** Runs only a fixed, server-generated Gmsh+CalculiX driver in a short-lived, secret-free image. */
export async function runFeaInSandbox(input: DriverInput, stepBytes: Buffer): Promise<GeneratedFeaFiles> {
  const image = process.env.ENGINEERING_FEA_SANDBOX_IMAGE
  if (!image) throw new Error('FEA runtime is not configured (ENGINEERING_FEA_SANDBOX_IMAGE is required)')

  let stage = 'sandbox_create'
  let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | null = null
  try {
    sandbox = await Sandbox.create({ name: `fea-${crypto.randomUUID()}`, image, timeout: TIMEOUT_MS, resources: { vcpus: 1 }, networkPolicy: 'deny-all', env: {} })
    stage = 'input_write'
    const driverSource = feaDriverSource(input)
    await sandbox.writeFiles([
      { path: 'driver.py', content: driverSource },
      { path: 'part.step', content: stepBytes },
    ])

    stage = 'fea_execute'
    const command = await sandbox.runCommand('python3', ['driver.py'], { timeoutMs: TIMEOUT_MS })
    if (command.exitCode !== 0) {
      const stderr = safeDiagnostic(await command.stderr().catch(() => 'stderr unavailable'))
      throw new Error(`FEA driver process exited ${command.exitCode}: ${stderr}`)
    }

    stage = 'artifact_read'
    const [meshInp, analysisInp, analysisFrd, resultsRaw] = await Promise.all([
      sandbox.readFileToBuffer({ path: 'mesh.inp' }),
      sandbox.readFileToBuffer({ path: 'analysis.inp' }),
      sandbox.readFileToBuffer({ path: 'analysis.frd' }),
      sandbox.readFileToBuffer({ path: 'results.json' }),
    ])
    if (!meshInp || !analysisInp || !analysisFrd || !resultsRaw) throw new Error('FEA runtime produced incomplete output')
    if (meshInp.byteLength > MAX_OUTPUT_BYTES || analysisInp.byteLength > MAX_OUTPUT_BYTES || analysisFrd.byteLength > MAX_OUTPUT_BYTES) throw new Error('FEA runtime produced oversized output')
    if (resultsRaw.byteLength > MAX_RESULT_JSON_BYTES) throw new Error('FEA runtime produced oversized results')

    stage = 'results_validate'
    return { driverSource, meshInp, analysisInp, analysisFrd, results: validateResults(JSON.parse(resultsRaw.toString('utf8'))) }
  } catch (error) {
    const diagnostic = safeDiagnostic(error)
    console.error(`[engineering/fea/runtime] stage=${stage} image=${image} failure=${diagnostic}`)
    throw new Error(`FEA runtime failed at ${stage}: ${diagnostic}`, { cause: error })
  } finally {
    await sandbox?.stop().catch((error) => {
      console.warn(`[engineering/fea/runtime] sandbox_stop failure=${safeDiagnostic(error)}`)
    })
  }
}
