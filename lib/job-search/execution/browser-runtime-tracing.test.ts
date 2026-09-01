import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Contract: every route that can reach the browser executor must have the
 * browser runtime files traced into its deployment bundle.
 *
 * This has now failed in production twice. `playwright-core` reads
 * browsers.json at MODULE INITIALIZATION, so a route that transitively imports
 * the executor without these files traced does not fail gracefully at call
 * time — it throws MODULE_NOT_FOUND while the module is being loaded, which
 * means the function 500s *before* it ever reaches its own authorization
 * check. A cron route that should answer 401 to an unauthenticated request
 * answers 500 instead, and nothing in the build or the test suite notices.
 *
 * Static import-graph walk rather than a runtime check, because the failure
 * only reproduces in a deployed serverless bundle.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..')
const APP_DIR = join(REPO_ROOT, 'app')

/** Modules that pull in @sparticuz/chromium / playwright-core. */
const BROWSER_ENTRY_POINTS = [
  'lib/job-search/execution/providers/serverless-chromium',
  'lib/job-search/execution/executor',
  'lib/job-search/execution/batch',
  'lib/job-search/execution/autonomy',
]

/**
 * Traversal stops at the agent tool registry.
 *
 * The registry statically imports the job-search execution tools, so a naive
 * walk marks every route that loads Caye's tools — nine of them — as needing
 * traced browser files. They do not: /api/caye/job-search-inspect,
 * job-search-objective, morning-digest, eod-summary/cron,
 * opportunity-scan/cron, business-insights/cron, /api/founder/tools and both
 * webhooks were all checked against production and answer their own 401/403,
 * meaning they initialize fine without these files.
 *
 * Rather than assert a bundler theory that has not been verified, this guard
 * covers the hazard that WAS observed: a route wiring the executor in directly
 * rather than through the registry. /api/caye/job-search-apply did exactly
 * that and 500'd on module init in production, before its CRON_SECRET check.
 */
const TRAVERSAL_BOUNDARIES = [
  'lib/caye-agent/tools/registry',
  'lib/caye-agent/tools/high-risk-registry',
]

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) listFiles(full, out)
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

/** Resolve an import specifier to a repo-relative module path, or null. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2)
  if (specifier.startsWith('.')) {
    const fromDir = join(fromFile, '..')
    return relative(REPO_ROOT, join(fromDir, specifier)).split(sep).join('/')
  }
  return null
}

const IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const specifiers: string[] = []
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const resolved = resolveSpecifier(match[1], file)
    if (resolved) specifiers.push(resolved)
  }
  return specifiers
}

/** Does this file transitively reach the browser stack? */
function reachesBrowserRuntime(file: string, seen = new Set<string>()): boolean {
  const key = relative(REPO_ROOT, file).split(sep).join('/').replace(/\.tsx?$/, '')
  if (seen.has(key)) return false
  seen.add(key)
  if (BROWSER_ENTRY_POINTS.includes(key)) return true
  if (TRAVERSAL_BOUNDARIES.includes(key)) return false

  for (const specifier of importsOf(file)) {
    if (TRAVERSAL_BOUNDARIES.includes(specifier)) continue
    if (BROWSER_ENTRY_POINTS.includes(specifier)) return true
    for (const candidate of [`${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`]) {
      const full = join(REPO_ROOT, candidate)
      try {
        if (statSync(full).isFile() && reachesBrowserRuntime(full, seen)) return true
      } catch { /* not this extension */ }
    }
  }
  return false
}

/** "app/api/caye/job-search-apply/route.ts" -> "/api/caye/job-search-apply" */
function routePathFor(file: string): string {
  return '/' + relative(APP_DIR, join(file, '..')).split(sep).join('/')
}

function tracedPatterns(): string[] {
  const config = readFileSync(join(REPO_ROOT, 'next.config.ts'), 'utf8')
  const block = config.match(/outputFileTracingIncludes:\s*\{([\s\S]*?)\n\s{2}\}/)?.[1] ?? ''
  return [...block.matchAll(/'([^']+)':/g)].map((match) => match[1])
}

function isTraced(routePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern === routePath ||
    (pattern.endsWith('/**') && routePath.startsWith(pattern.slice(0, -3))))
}

describe('browser runtime file tracing', () => {
  const routes = listFiles(APP_DIR).filter((file) => /[\\/]route\.tsx?$/.test(file))

  it('finds the app routes to inspect', () => {
    expect(routes.length).toBeGreaterThan(10)
  })

  /**
   * Routes that reach the browser stack and are NOT traced, yet were each
   * checked against production and answer their own 401/403 — so they
   * initialize fine as bundled today. They are recorded rather than asserted
   * because the precise reason Next's tracer treats them differently has not
   * been established, and asserting an unverified bundler theory would be
   * worse than naming the uncertainty.
   *
   * The load-bearing guard is the next test. This one only catches a NEW
   * untraced route appearing, which is the situation that actually broke.
   */
  const KNOWN_HEALTHY_UNTRACED = [
    '/api/caye/business-insights/cron',
    '/api/caye/eod-summary/cron',
    '/api/caye/job-search-inspect',
    '/api/caye/job-search-objective',
    '/api/caye/morning-digest',
    '/api/caye/opportunity-scan/cron',
    '/api/founder/tools',
    '/api/webhooks/whatsapp-operator',
    '/api/webhooks/zoho-email',
  ]

  it('has no NEW untraced route that can reach the browser executor', () => {
    const patterns = tracedPatterns()
    const untraced = routes
      .filter((file) => reachesBrowserRuntime(file))
      .map(routePathFor)
      .filter((routePath) => !isTraced(routePath, patterns))
      .filter((routePath) => !KNOWN_HEALTHY_UNTRACED.includes(routePath))

    // A new route here risks 500ing on module init in production, before its
    // own authorization check — verify it against a deployment, and add it to
    // outputFileTracingIncludes in next.config.ts if it fails to initialize.
    expect(untraced).toEqual([])
  })

  it('covers the autonomous application worker specifically', () => {
    const worker = join(APP_DIR, 'api', 'caye', 'job-search-apply', 'route.ts')
    expect(reachesBrowserRuntime(worker)).toBe(true)
    expect(isTraced('/api/caye/job-search-apply', tracedPatterns())).toBe(true)
  })
})
