/**
 * Job-search operator (CAY-194 / #194) — founder-only isolation and
 * no-stealth-dependency regression tests.
 *
 * Extends the same structural approach as lib/job-search/leakage.test.ts
 * (CAY-192) to this PR's new execution/ subtree, plus the two new
 * regression requirements #194 calls out specifically: the new Admin
 * Shell tools are founder-only and admin-surface-only (#194 scenarios 24
 * & 25), and no browser-stealth/anti-detection dependency was introduced
 * anywhere in the repo (#194 scenario 28).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const EXECUTION_DIR = path.resolve(__dirname)
const JOB_SEARCH_DIR = path.resolve(__dirname, '..')

function listSourceFiles(dir: string, predicate: (entry: string) => boolean): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) files.push(...listSourceFiles(full, predicate))
    else if (predicate(entry)) files.push(full)
  }
  return files
}

describe('lib/job-search/execution — founder-data isolation (#194 scenario 24)', () => {
  it('no execution module references workspace scoping', () => {
    const offenders: { file: string; line: number; text: string }[] = []
    for (const file of listSourceFiles(EXECUTION_DIR, (e) => e.endsWith('.ts') && !e.endsWith('.test.ts'))) {
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, idx) => {
        if (/workspace_id|workspaceId/.test(line)) {
          offenders.push({ file: path.relative(EXECUTION_DIR, file), line: idx + 1, text: line.trim() })
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('New Admin Shell tools are founder-only and never front-desk-reachable (#194 scenario 25)', () => {
  it.each([
    'list-applications-needing-review',
    'explain-application-status',
    'get-application-submission-evidence',
    'get-execution-daily-summary',
  ])('read tool %s has roles=[founder] and excludes front-desk/driver modes', async (fileBase) => {
    const mod = await import(`../../caye-agent/tools/admin/read/${fileBase}.ts`)
    const tool = Object.values(mod)[0] as { roles: string[]; modes: string[] }
    expect(tool.roles).toEqual(['founder'])
    expect(tool.modes).not.toContain('front-desk')
    expect(tool.modes).not.toContain('driver')
  })

  it.each([
    'pause-application-execution',
    'resume-application-execution',
    'enable-dry-run-mode',
    'disable-application-automation',
  ])('low-risk write tool %s has roles=[founder] and excludes front-desk/driver modes', async (fileBase) => {
    const mod = await import(`../../caye-agent/tools/admin/write-low/${fileBase}.ts`)
    const tool = Object.values(mod)[0] as { roles: string[]; modes: string[] }
    expect(tool.roles).toEqual(['founder'])
    expect(tool.modes).not.toContain('front-desk')
    expect(tool.modes).not.toContain('driver')
  })

  it.each([
    'enable-application-automation',
    'disable-dry-run-mode',
    'set-daily-submission-cap',
  ])('high-risk write tool %s is admin-shell-only and requires confirmation (risk=high)', async (fileBase) => {
    const mod = await import(`../../caye-agent/tools/admin/write-high/${fileBase}.ts`)
    const tool = Object.values(mod)[0] as { roles: string[]; modes: string[]; risk: string }
    expect(tool.roles).toEqual(['founder'])
    expect(tool.modes).toEqual(['admin-shell'])
    expect(tool.risk).toBe('high')
  })
})

describe('No browser-stealth/anti-detection dependency anywhere in the repo (#194 scenario 28)', () => {
  it('package.json has no stealth/anti-detection browser-automation packages', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    const forbidden = Object.keys(allDeps).filter((name) => /stealth|undetected|anti-detect|puppeteer-extra|playwright-extra/i.test(name))
    expect(forbidden).toEqual([])
  })

  it('no source file in lib/job-search imports a stealth/anti-detection package', () => {
    // Excludes this test file itself and its own pattern list — otherwise
    // the regex literal below would flag itself.
    const offenders: string[] = []
    for (const file of listSourceFiles(JOB_SEARCH_DIR, (e) => e.endsWith('.ts') && e !== 'isolation.test.ts')) {
      const content = readFileSync(file, 'utf8')
      if (/stealth|undetected-chromedriver|puppeteer-extra|playwright-extra/i.test(content)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
