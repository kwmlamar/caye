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

describe('Rollout controls are unreachable from any customer-facing surface (post-audit)', () => {
  // Behavioral, not declarative: this asks the real tool-surface selector what
  // each (mode, role) pair can actually execute, rather than trusting the
  // `roles`/`modes` fields the tools declare about themselves.
  const ROLLOUT_TOOL = /automation|dry_run|submission_cap|application_execution/

  async function toolNamesFor(mode: 'front-desk' | 'back-office' | 'admin-shell', callerRole: 'owner' | 'staff' | 'founder' | 'driver') {
    const { selectToolSurface } = await import('../../caye-agent/execute')
    return selectToolSurface({ ctx: { workspaceId: 'ws_test', callerRole, requestId: 'req' }, mode }).tools.map((t) => t.name)
  }

  it.each(['owner', 'staff', 'founder', 'driver'] as const)('the front-desk (customer-facing) surface exposes no rollout control to %s', async (role) => {
    const names = await toolNamesFor('front-desk', role)
    expect(names.filter((n) => ROLLOUT_TOOL.test(n))).toEqual([])
  })

  it.each(['owner', 'staff', 'driver'] as const)('a non-founder (%s) can reach no rollout control in any mode', async (role) => {
    for (const mode of ['front-desk', 'back-office', 'admin-shell'] as const) {
      const names = await toolNamesFor(mode, role)
      expect(names.filter((n) => ROLLOUT_TOOL.test(n))).toEqual([])
    }
  })

  it('the capability-INCREASING controls are admin-shell-only, even for the founder', async () => {
    // Asymmetry by design: the founder can hit the brakes from either channel,
    // but anything that makes real submission more possible is confined to the
    // deliberate admin surface.
    const backOffice = await toolNamesFor('back-office', 'founder')
    for (const risky of ['enable_application_automation', 'disable_dry_run_mode', 'set_daily_submission_cap']) {
      expect(backOffice).not.toContain(risky)
    }
    const adminShell = await toolNamesFor('admin-shell', 'founder')
    for (const risky of ['enable_application_automation', 'disable_dry_run_mode', 'set_daily_submission_cap']) {
      expect(adminShell).toContain(risky)
    }
  })

  it('the safety-INCREASING controls stay available to the founder in back-office too', async () => {
    const backOffice = await toolNamesFor('back-office', 'founder')
    expect(backOffice).toContain('pause_application_execution')
    expect(backOffice).toContain('enable_dry_run_mode')
    expect(backOffice).toContain('disable_application_automation')
  })
})

describe('executeApplication is not reachable from any agent tool or HTTP route (post-audit)', () => {
  // The submission entry point must not be callable by anything that a
  // customer conversation, a front-desk turn, or an unauthenticated request
  // could reach. Today it has no production caller at all; this test fails
  // the moment one is added anywhere outside the execution subtree, so wiring
  // it up becomes a deliberate, reviewed act rather than an import.
  it('nothing outside lib/job-search/execution imports the executor', () => {
    const roots = ['app', 'components', 'lib', 'scripts'].map((d) => path.join(REPO_ROOT, d))
    const offenders: string[] = []
    for (const root of roots) {
      let files: string[] = []
      try {
        files = listSourceFiles(root, (e) => e.endsWith('.ts') || e.endsWith('.tsx'))
      } catch {
        continue // directory absent in this checkout
      }
      for (const file of files) {
        if (file.startsWith(EXECUTION_DIR)) continue
        if (/\bexecuteApplication\b/.test(readFileSync(file, 'utf8'))) {
          offenders.push(path.relative(REPO_ROOT, file))
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('no ATS provider declares itself able to submit', async () => {
    // The capability gate the executor relies on. If a provider ever flips
    // this to true, the daily-cap reservation race documented in rollout.ts
    // must be closed first — this test is the tripwire for that review.
    const { greenhouseAtsProvider } = await import('./providers/greenhouse')
    const { unsupportedProvider } = await import('./providers/unsupported')
    expect(greenhouseAtsProvider.canSubmit).toBe(false)
    expect(unsupportedProvider('lever').canSubmit).toBe(false)
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
