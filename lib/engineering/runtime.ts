import 'server-only'
import { Sandbox } from '@vercel/sandbox'
import type { EngineeringSpec } from './spec'
import { cadQuerySource } from './cadquery-source'

const TIMEOUT_MS = 90_000
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024
const MAX_DIAGNOSTIC_CHARS = 2_000
const DEFAULT_CAD_SANDBOX_IMAGE = 'caye-engineering:cadquery-v2'

export type GeneratedCadFiles = { source: string; stl: Buffer; step: Buffer; metadata: { bounds_mm: Record<string, number>; volume_mm3: number } }

type CadImageEnv = {
  ENGINEERING_CAD_SANDBOX_IMAGE?: string
  ENGINEERING_SANDBOX_IMAGE?: string
}

/**
 * CAD and FEA intentionally have separate runtime images. During the FEA rollout,
 * the legacy ENGINEERING_SANDBOX_IMAGE value was overwritten with caye-fea:latest,
 * which made CAD revisions execute inside the solver image and fail before geometry
 * was produced. Prefer the explicit CAD variable, accept the legacy variable only
 * when it is clearly not the FEA image, and otherwise fall back to the known-good
 * CadQuery image that Engineering V1 was built and validated against.
 */
export function resolveCadSandboxImage(env: CadImageEnv = process.env): string {
  const explicitCadImage = env.ENGINEERING_CAD_SANDBOX_IMAGE?.trim()
  if (explicitCadImage) return explicitCadImage

  const legacyImage = env.ENGINEERING_SANDBOX_IMAGE?.trim()
  if (legacyImage && !/^caye-fea(?::|$)/i.test(legacyImage)) return legacyImage

  if (legacyImage) {
    console.warn(`[engineering/runtime] refusing FEA image for CAD generation image=${legacyImage}; using ${DEFAULT_CAD_SANDBOX_IMAGE}`)
  }
  return DEFAULT_CAD_SANDBOX_IMAGE
}

function safeDiagnostic(value: unknown): string {
  const raw = value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, MAX_DIAGNOSTIC_CHARS)
}

function validateMetadata(input: unknown): GeneratedCadFiles['metadata'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('CAD runtime emitted invalid metadata')
  const raw = input as { bounds_mm?: unknown; volume_mm3?: unknown }
  if (!raw.bounds_mm || typeof raw.bounds_mm !== 'object' || Array.isArray(raw.bounds_mm)) throw new Error('CAD runtime emitted invalid bounds')
  const bounds = raw.bounds_mm as Record<string, unknown>
  const normalized: Record<string, number> = {}
  for (const key of ['x', 'y', 'z']) {
    const value = bounds[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 2_000) throw new Error('CAD runtime emitted unsafe bounds')
    normalized[key] = value
  }
  if (typeof raw.volume_mm3 !== 'number' || !Number.isFinite(raw.volume_mm3) || raw.volume_mm3 <= 0 || raw.volume_mm3 > 8_000_000_000) throw new Error('CAD runtime emitted invalid volume')
  return { bounds_mm: normalized, volume_mm3: raw.volume_mm3 }
}

/** Runs only a fixed CadQuery template in a short-lived, secret-free image. */
export async function generateCadInSandbox(spec: EngineeringSpec): Promise<GeneratedCadFiles> {
  const image = resolveCadSandboxImage()

  let stage = 'sandbox_create'
  let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | null = null
  try {
    sandbox = await Sandbox.create({ name: `engineering-${crypto.randomUUID()}`, image, timeout: TIMEOUT_MS, resources: { vcpus: 1 }, networkPolicy: 'deny-all', env: {} })
    stage = 'source_write'
    const source = cadQuerySource(spec)
    await sandbox.writeFiles([{ path: 'part.py', content: source }])

    stage = 'cadquery_execute'
    const command = await sandbox.runCommand('python', ['part.py'], { timeoutMs: TIMEOUT_MS })
    if (command.exitCode !== 0) {
      const stderr = safeDiagnostic(await command.stderr().catch(() => 'stderr unavailable'))
      throw new Error(`CAD generation process exited ${command.exitCode}: ${stderr}`)
    }

    stage = 'artifact_read'
    const [stl, step, metadata] = await Promise.all([
      sandbox.readFileToBuffer({ path: 'part.stl' }), sandbox.readFileToBuffer({ path: 'part.step' }), sandbox.readFileToBuffer({ path: 'metadata.json' }),
    ])
    if (!stl || !step || !metadata || stl.byteLength > MAX_OUTPUT_BYTES || step.byteLength > MAX_OUTPUT_BYTES) throw new Error('CAD runtime produced invalid or oversized output')
    if (metadata.byteLength > 128 * 1024) throw new Error('CAD runtime produced oversized metadata')

    stage = 'metadata_validate'
    return { source, stl, step, metadata: validateMetadata(JSON.parse(metadata.toString('utf8'))) }
  } catch (error) {
    const diagnostic = safeDiagnostic(error)
    console.error(`[engineering/runtime] stage=${stage} image=${image} failure=${diagnostic}`)
    throw new Error(`Engineering runtime failed at ${stage}: ${diagnostic}`, { cause: error })
  } finally {
    await sandbox?.stop().catch((error) => {
      console.warn(`[engineering/runtime] sandbox_stop failure=${safeDiagnostic(error)}`)
    })
  }
}
