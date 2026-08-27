import 'server-only'
import { createHash } from 'node:crypto'

/** Shared by the CAD artifact pipeline (artifacts.ts) and the FEA analysis pipeline (fea/analysis.ts). */
export function checksum(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

export async function cleanupStagedEngineeringFiles(storage: { remove(paths: string[]): PromiseLike<{ error: { message: string } | null }> }, paths: readonly string[]): Promise<void> {
  if (!paths.length) return
  const { error } = await storage.remove([...new Set(paths)])
  if (error && !/not found|does not exist/i.test(error.message)) throw new Error(`Could not clean staged engineering files: ${error.message}`)
}
