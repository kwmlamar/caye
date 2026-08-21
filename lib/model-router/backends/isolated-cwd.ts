import 'server-only'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Both subscription CLIs get a fresh, empty, per-invocation scratch
 * directory as their `cwd` — belt-and-suspenders beyond
 * --allowedTools ""/--sandbox read-only. Even if a flag-parsing edge case
 * or a future CLI version changes what "no tools" actually blocks, the
 * worst case is the CLI looking at an empty directory, never this repo,
 * never Caye's secrets. Found necessary during live testing: Codex refuses
 * to run outside a trusted git repo without --skip-git-repo-check, which
 * is what led to deliberately isolating cwd rather than running from
 * wherever the Node process happened to start.
 */
export async function withIsolatedCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'caye-model-router-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
