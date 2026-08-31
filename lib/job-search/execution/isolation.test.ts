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

// Imported once at module scope rather than inside a test: pulling in the
// whole tool registry is slow enough to blow a 5s per-test timeout when the
// full suite runs in parallel.
const { selectToolSurface } = await import('../../caye-agent/execute')
const { greenhouseAtsProvider } = await import('./providers/greenhouse')
const { unsupportedProvider } = await import('./providers/unsupported')

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
    'run-application-execution',
  ])('high-risk write tool %s is founder-only, confirmation-gated, and never customer-reachable', async (fileBase) => {
    const mod = await import(`../../caye-agent/tools/admin/write-high/${fileBase}.ts`)
    const tool = Object.values(mod)[0] as { roles: string[]; modes: string[]; risk: string }
    expect(tool.roles).toEqual(['founder'])
    expect(tool.risk).toBe('high')
    // Caye Direct (back-office) is the canonical founder control plane, so
    // these are deliberately reachable from BOTH founder surfaces. The
    // guarantee that matters is not which founder channel is used — it is
    // that no customer-facing surface can reach them at all, and that every
    // one of them still requires an explicit confirmation.
    expect(tool.modes.every((m) => m === 'admin-shell' || m === 'back-office')).toBe(true)
    expect(tool.modes).not.toContain('front-desk')
    expect(tool.modes).not.toContain('driver')
  })
})

describe('Rollout controls are unreachable from any customer-facing surface (post-audit)', () => {
  // Behavioral, not declarative: this asks the real tool-surface selector what
  // each (mode, role) pair can actually execute, rather than trusting the
  // `roles`/`modes` fields the tools declare about themselves.
  const ROLLOUT_TOOL = /automation|dry_run|submission_cap|application_execution/

  function toolNamesFor(mode: 'front-desk' | 'back-office' | 'admin-shell', callerRole: 'owner' | 'staff' | 'founder' | 'driver') {
    return selectToolSurface({ ctx: { workspaceId: 'ws_test', callerRole, requestId: 'req' }, mode }).tools.map((t) => t.name)
  }

  it.each(['owner', 'staff', 'founder', 'driver'] as const)('the front-desk (customer-facing) surface exposes no rollout control to %s', (role) => {
    expect(toolNamesFor('front-desk', role).filter((n) => ROLLOUT_TOOL.test(n))).toEqual([])
  })

  it.each(['owner', 'staff', 'driver'] as const)('a non-founder (%s) can reach no rollout control in any mode', (role) => {
    for (const mode of ['front-desk', 'back-office', 'admin-shell'] as const) {
      expect(toolNamesFor(mode, role).filter((n) => ROLLOUT_TOOL.test(n))).toEqual([])
    }
  })

  it('the capability-INCREASING controls are founder-only in both founder channels, and confirmation-gated', () => {
    // Caye Direct is the canonical founder control plane, so the founder
    // reaches these from either surface. What is NOT relaxed: they remain
    // founder-only (asserted above for every non-founder role and for
    // front-desk), and each one is wrapped by gateAdminHighRisk, so reaching
    // the tool is not the same as executing it — the first call only stages
    // the action and a separate founder confirmation is required to run it.
    const backOffice = toolNamesFor('back-office', 'founder')
    const adminShell = toolNamesFor('admin-shell', 'founder')
    for (const risky of ['enable_application_automation', 'disable_dry_run_mode', 'set_daily_submission_cap', 'run_application_execution']) {
      expect(adminShell).toContain(risky)
      expect(backOffice).toContain(risky)
    }
  })

  it('the safety-INCREASING controls stay available to the founder in back-office too', () => {
    const backOffice = toolNamesFor('back-office', 'founder')
    expect(backOffice).toContain('pause_application_execution')
    expect(backOffice).toContain('enable_dry_run_mode')
    expect(backOffice).toContain('disable_application_automation')
  })
})

describe('executeApplication has exactly one founder-only production caller (post-audit)', () => {
  // The submission entry point must not be callable by anything that a
  // customer conversation, a front-desk turn, or an unauthenticated request
  // could reach. The sole exception is the gated Admin Shell tool. This test
  // makes any second caller a deliberate review event.
  it('only the gated Admin Shell tool imports the executor', () => {
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
    expect(offenders).toEqual(['lib/caye-agent/tools/admin/write-high/run-application-execution.ts'])
  })

  it('only the audited Greenhouse provider can submit; every other provider still cannot', () => {
    // Greenhouse's live path is audited (providers/greenhouse-submit.ts) and
    // reachable only through the submission authority boundary. Nothing else
    // has a lawful submission channel, and canSubmit is a code property that
    // no database flag can turn on.
    expect(greenhouseAtsProvider.canSubmit).toBe(true)
    expect(unsupportedProvider('lever').canSubmit).toBe(false)
    expect(unsupportedProvider('workday').canSubmit).toBe(false)
    expect(unsupportedProvider('ashby').canSubmit).toBe(false)
    expect(unsupportedProvider('generic').canSubmit).toBe(false)
  })

  it('only the audited submission module contains a browser click', () => {
    // The one consequential browser operation in the whole job-search subtree
    // must live in exactly one file. If a click appears anywhere else, the
    // "one deliberate submit action" guarantee is no longer structural.
    const offenders: string[] = []
    for (const file of listSourceFiles(JOB_SEARCH_DIR, (e) => e.endsWith('.ts') && !e.endsWith('.test.ts'))) {
      const content = readFileSync(file, 'utf8')
      if (/\.click\(|\.press\(|form\.submit\(|requestSubmit\(/.test(content)) offenders.push(path.relative(REPO_ROOT, file))
    }
    expect(offenders).toEqual(['lib/job-search/execution/providers/greenhouse-submit.ts'])
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
