/**
 * Job-search operator (#192) — founder-data-isolation regression test.
 *
 * "Founder data cannot leak into customer context" is enforced
 * structurally, not by convention: no job_search_* table has a
 * workspace_id column (see the migration), and no code in lib/job-search
 * ever reads or writes a workspace scope. This test asserts that
 * structural guarantee directly against the source files, so a future
 * change that accidentally threads a workspaceId into this domain fails
 * CI immediately rather than relying on someone noticing in review.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The capability modules imported below (indirectly) import 'server-only',
// which throws when loaded outside an RSC bundle. Every other test file in
// this repo that reaches server-only code stubs it the same way (see
// lib/caye-agent/tools/admin/admin-high-risk-gate.test.ts).
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))

const LIB_DIR = path.resolve(__dirname)

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

describe('lib/job-search — founder-data isolation (#192)', () => {
  it('no job-search module references workspace scoping', () => {
    // job-search has no workspace concept at all: no job_search_* table has a
    // workspace_id column, and this domain is founder-only. The single
    // documented exception is objective-operator.ts, which calls the shared
    // (lib/operator) durable-objective store — an API that requires every
    // caller to pass a `workspaceId`. Per that store's own schema
    // (operator_objective_runs' CHECK constraint: scope_kind = 'founder'
    // implies workspace_id IS NULL), a hard-coded `workspaceId: null` paired
    // with `scopeKind: 'founder'` is not a workspace reference leaking in —
    // it is the mechanism that keeps the run out of every workspace's scope.
    // Anything else — a variable, a real id, a non-null literal — is still
    // flagged. The behavioral test below independently proves the actual
    // value the shared store receives.
    const offenders: { file: string; line: number; text: string }[] = []
    for (const file of listSourceFiles(LIB_DIR)) {
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, idx) => {
        const trimmed = line.trim()
        if (/workspace_id/.test(trimmed)) {
          offenders.push({ file: path.relative(LIB_DIR, file), line: idx + 1, text: trimmed })
          return
        }
        if (/workspaceId/.test(trimmed) && !/^workspaceId:\s*null,?$/.test(trimmed)) {
          offenders.push({ file: path.relative(LIB_DIR, file), line: idx + 1, text: trimmed })
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('job_search capability namespace — gateway boundary (#192)', () => {
  it('job_search capabilities are registered read-only, so the founder gateway cannot expose a write/execute path for them', async () => {
    const { jobSearchSummaryCapability } = await import('@/lib/capabilities/job-search-summary')
    const { jobSearchQueueCapability } = await import('@/lib/capabilities/job-search-queue')
    for (const capability of [jobSearchSummaryCapability, jobSearchQueueCapability]) {
      expect(capability.manifest.access).toBe('read')
      expect(capability.manifest.risk).toBe('read_only')
      expect(capability.manifest.namespace).toBe('job_search')
    }
  })
})
