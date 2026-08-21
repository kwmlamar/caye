import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Structural regression guard: "customer/operator/background paths cannot
 * invoke subscription routing" is a claim about the whole repo's import
 * graph, not something a single function's unit test can prove. This
 * walks the real production entry points — webhooks, cron, and the shared
 * agent runtime — and asserts none of them import lib/model-router. If a
 * future change wires this router into one of those paths, this test
 * fails loudly rather than the isolation guarantee silently eroding.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FORBIDDEN_IMPORT = /from\s+['"]@\/lib\/model-router/

const PATHS_THAT_MUST_NEVER_IMPORT_MODEL_ROUTER = [
  'app/api/webhooks',
  // Covers every cron route (app/api/caye/*/cron) plus the rest of the
  // customer/background caye API surface — deliberately broader than just
  // the /cron subdirectories.
  'app/api/caye',
  'lib/caye-agent/execute.ts',
  'lib/caye-agent/orchestrator.ts',
  'lib/caye-agent/index.ts',
  'lib/caye-reply.ts',
]

function walk(path: string, out: string[] = []): string[] {
  const stat = statSync(path)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === '.next') continue
      walk(join(path, entry), out)
    }
  } else if (/\.(ts|tsx)$/.test(path) && !path.endsWith('.test.ts')) {
    out.push(path)
  }
  return out
}

describe('lib/model-router isolation from production customer/background paths', () => {
  for (const relPath of PATHS_THAT_MUST_NEVER_IMPORT_MODEL_ROUTER) {
    it(`${relPath} does not import lib/model-router`, () => {
      const fullPath = join(REPO_ROOT, relPath)
      const files = walk(fullPath)
      expect(files.length).toBeGreaterThan(0) // sanity: the path must actually exist and contain files

      const offenders = files.filter((f) => FORBIDDEN_IMPORT.test(readFileSync(f, 'utf8')))
      expect(offenders).toEqual([])
    })
  }
})
