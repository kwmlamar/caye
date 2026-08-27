import 'server-only'
import { Sandbox } from '@vercel/sandbox'
import type { EngineeringSpec } from './spec'
import { cadQuerySource } from './cadquery-source'

const TIMEOUT_MS = 90_000
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024
const MAX_DIAGNOSTIC_CHARS = 2_000

export type GeneratedCadFiles = { source: string; stl: Buffer; step: Buffer; metadata: { bounds_mm: Record<string, number>; volume_mm3: number } }

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
  const image = process.env.ENGINEERING_SANDBOX_IMAGE
  if (!image) throw new Error('Engineering runtime is not configured (ENGINEERING_SANDBOX_IMAGE is required)')

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
