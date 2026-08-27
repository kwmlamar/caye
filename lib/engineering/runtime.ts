import 'server-only'
import { Sandbox } from '@vercel/sandbox'
import type { EngineeringSpec } from './spec'
import { cadQuerySource } from './cadquery-source'

const TIMEOUT_MS = 90_000
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024

export type GeneratedCadFiles = { source: string; stl: Buffer; step: Buffer; metadata: { bounds_mm: Record<string, number>; volume_mm3: number } }

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
  const sandbox = await Sandbox.create({ name: `engineering-${crypto.randomUUID()}`, image, timeout: TIMEOUT_MS, resources: { vcpus: 1 }, networkPolicy: 'deny-all', env: {} })
  try {
    const source = cadQuerySource(spec)
    await sandbox.writeFiles([{ path: 'part.py', content: source }])
    const command = await sandbox.runCommand('python', ['part.py'], { timeoutMs: TIMEOUT_MS })
    if (command.exitCode !== 0) throw new Error('CAD generation failed in the isolated runtime')
    const [stl, step, metadata] = await Promise.all([
      sandbox.readFileToBuffer({ path: 'part.stl' }), sandbox.readFileToBuffer({ path: 'part.step' }), sandbox.readFileToBuffer({ path: 'metadata.json' }),
    ])
    if (!stl || !step || !metadata || stl.byteLength > MAX_OUTPUT_BYTES || step.byteLength > MAX_OUTPUT_BYTES) throw new Error('CAD runtime produced invalid or oversized output')
    if (metadata.byteLength > 128 * 1024) throw new Error('CAD runtime produced oversized metadata')
    return { source, stl, step, metadata: validateMetadata(JSON.parse(metadata.toString('utf8'))) }
  } finally {
    await sandbox.stop().catch(() => {})
  }
}
