import 'server-only'
import { Sandbox } from '@vercel/sandbox'
import type { EngineeringSpec } from './spec'
import { cadQuerySource } from './cadquery-source'

const TIMEOUT_MS = 90_000
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024

export type GeneratedCadFiles = { source: string; stl: Buffer; step: Buffer; metadata: { bounds_mm: Record<string, number>; volume_mm3: number } }

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
    return { source, stl, step, metadata: JSON.parse(metadata.toString('utf8')) }
  } finally {
    await sandbox.stop().catch(() => {})
  }
}
