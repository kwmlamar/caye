#!/usr/bin/env node
/**
 * Read-only audit of the migration ledger against the repo.
 *
 * Enforces one invariant:
 *
 *     repo migration identity == recorded migration identity
 *
 * It writes nothing and holds no DDL. What it can actually prove depends on
 * which read-only RPC the database exposes, and it says so rather than
 * implying otherwise:
 *
 *   applied_migration_names()   (20260728b, applied)
 *       -> `setof text`. Names only. Enough for aliases, unrecorded
 *          migrations, unknown rows and duplicate names. NOT enough to
 *          identify which row is a duplicate, to bound pre-convention history
 *          by date, or to honour the created_by reconciliation exemption.
 *
 *   applied_migration_ledger()  (20260902140000, NOT yet applied)
 *       -> version, name, created_by. Enables the full audit.
 *
 * The script prefers the richer RPC, falls back to the names-only one, and
 * prints exactly which checks it could not run in that mode. A check that
 * quietly downgrades itself is how the last watchdog lost its credibility.
 *
 * What counts as a violation
 * -------------------------
 * Most of this ledger predates the exact-filename convention: 118 of its rows
 * are bare slugs (`caye_threads` for `20260528_caye_threads`). Those are
 * matched by the drift watchdog's legacy slug fallback and are NOT drift.
 * Reporting them as failures would make this tool permanently red and worth
 * ignoring, which is the failure mode it exists to correct.
 *
 * So a FAILURE is only:
 *   · a migration filename the prefix expression cannot parse
 *   · a migration with no ledger row of any shape
 *   · (rich mode only) a migration recorded under an alias at or after
 *     --since, i.e. after the convention took effect
 *
 * Everything else — pre-convention slugs, duplicate names, rows naming
 * nothing in the repo — is reported as history, counted but never failed on.
 *
 *     node scripts/check-migration-ledger.mjs                    # audit
 *     node scripts/check-migration-ledger.mjs --strict           # exit 1 on a violation
 *     node scripts/check-migration-ledger.mjs --since 2026090213 # move the boundary
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, from the
 * environment or .env.local. Without them it audits nothing and exits 2 rather
 * than pretending to pass.
 *
 * Exit codes: 0 clean · 1 violations (with --strict) · 2 could not audit.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadEnv() {
  const env = { ...process.env }
  const file = join(root, '.env.local')
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return env
}

// Kept identical to MIGRATION_PREFIX in lib/db/migration-match.ts; a test in
// lib/db/migration-identity.test.ts fails if they drift apart.
const MIGRATION_PREFIX = /^\d{8}(?:\d{2}|\d{4}|\d{6})?[a-z]{0,2}_/
const slugOf = (n) => n.replace(MIGRATION_PREFIX, '')
const RECONCILIATION_MARKER_PREFIX = 'migration-drift-reconciliation-'

// First ledger version written under the exact-filename convention — the
// 2026-09-02 reconciliation batch. Rows at or after this are held to the
// invariant; older ones are history. Only meaningful in rich mode, which is
// the only mode that can see `version`.
const DEFAULT_SINCE_VERSION = '20260902130001'
const sinceArgIndex = process.argv.indexOf('--since')
const SINCE_VERSION =
  sinceArgIndex >= 0 && process.argv[sinceArgIndex + 1]
    ? process.argv[sinceArgIndex + 1]
    : DEFAULT_SINCE_VERSION

/**
 * The verified historical exceptions from lib/db/migration-match.ts — migrations
 * proven applied whose ledger name resembles nothing (20260611_eod_summary was
 * recorded as "eod_summary_schedule"). The drift watchdog suppresses them; this
 * audit must too, or it reports eleven known-good migrations as missing.
 *
 * Read out of the TypeScript source rather than restated, so the two cannot
 * drift apart. A test in lib/db/migration-identity.test.ts asserts this parse
 * still finds every entry.
 */
function legacyReconciled() {
  const src = readFileSync(join(root, 'lib', 'db', 'migration-match.ts'), 'utf8')
  const block = src.match(/LEGACY_RECONCILED[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/)
  if (!block) {
    console.error('\n  ✗ could not read LEGACY_RECONCILED from lib/db/migration-match.ts\n')
    process.exit(2)
  }
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]))
}
const LEGACY_RECONCILED = legacyReconciled()

const repo = readdirSync(join(root, 'supabase', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => f.replace(/\.sql$/, ''))
  .sort()

const malformed = repo.filter((n) => !MIGRATION_PREFIX.test(n))

const env = loadEnv()
const url = env.NEXT_PUBLIC_SUPABASE_URL
const key = env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error(
    '\n  ✗ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — ledger not audited.\n' +
      '    Repo-side checks only:\n'
  )
  console.error(`    migrations on disk : ${repo.length}`)
  console.error(`    malformed filenames: ${malformed.length}`)
  for (const m of malformed) console.error(`      · ${m}`)
  process.exit(malformed.length ? 1 : 2)
}

async function rpc(fn) {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) return { ok: false, status: res.status, body: await res.text() }
  return { ok: true, data: await res.json() }
}

/**
 * Rows as {version, name, created_by}. In names-only mode version and
 * created_by are null and `rich` is false — every check that needs them is
 * then skipped and reported as skipped.
 */
let rows
let rich = false

const full = await rpc('applied_migration_ledger')
if (full.ok) {
  rows = full.data.map((r) => ({
    version: r.version ?? null,
    name: r.name ?? null,
    created_by: r.created_by ?? null,
  }))
  rich = true
} else {
  const names = await rpc('applied_migration_names')
  if (!names.ok) {
    console.error(
      `\n  ✗ could not read the ledger.\n` +
        `    applied_migration_ledger: ${full.status} ${full.body}\n` +
        `    applied_migration_names : ${names.status} ${names.body}\n`
    )
    process.exit(2)
  }
  rows = names.data.map((n) => ({ version: null, name: n, created_by: null }))
}

const applied = rows.map((r) => r.name).filter(Boolean)
const appliedSet = new Set(applied)
const repoSet = new Set(repo)

// ── findings ───────────────────────────────────────────────────────────────
const aliased = []
const unknownRows = []
const notRecorded = []

const bySlug = new Map()
for (const n of applied) {
  const s = slugOf(n)
  bySlug.set(s, [...(bySlug.get(s) ?? []), n])
}

const explainedAliases = new Set()
// A repo migration is EITHER recorded exactly, OR recorded under some other
// name, OR not recorded at all. The middle case splits again by when the row
// was written — pre-convention slugs are history; a post-convention alias is a
// violation.
const legacyAliases = []
for (const migration of repo) {
  const aliasRows = rows.filter(
    (r) => r.name && r.name !== migration && slugOf(r.name) === slugOf(migration)
  )
  for (const r of aliasRows) explainedAliases.add(r.name)
  if (appliedSet.has(migration)) continue
  if (!aliasRows.length) {
    // A verified historical exception is recorded under a name that matches
    // nothing; it is not missing.
    if (!LEGACY_RECONCILED.has(migration)) notRecorded.push(migration)
    continue
  }
  const row = aliasRows[0]
  const postConvention = rich && row.version && row.version >= SINCE_VERSION
  ;(postConvention ? aliased : legacyAliases).push({
    migration,
    recordedAs: row.name,
    version: row.version,
  })
}

for (const row of rows) {
  if (!row.name) continue
  if (repoSet.has(row.name)) continue
  if (explainedAliases.has(row.name)) continue
  // Only provable with the richer RPC. In names-only mode this exemption
  // cannot be applied, and the report says so.
  if (rich && row.created_by?.startsWith(RECONCILIATION_MARKER_PREFIX)) continue
  unknownRows.push(row)
}

const versionsByName = new Map()
for (const row of rows) {
  if (!row.name) continue
  versionsByName.set(row.name, [...(versionsByName.get(row.name) ?? []), row.version])
}
const dupes = [...versionsByName.entries()]
  .filter(([, versions]) => versions.length > 1)
  .map(([name, versions]) => ({ name, count: versions.length, versions }))

// ── report ─────────────────────────────────────────────────────────────────
const line = (s = '') => console.log(s)
line()
line(
  `  source             : ${
    rich
      ? 'applied_migration_ledger() — version, name, created_by'
      : 'applied_migration_names() — names only'
  }`
)
line(`  migrations on disk : ${repo.length}`)
line(`  ledger rows        : ${rows.length} (${appliedSet.size} distinct names)`)
line(`  exact-name matches : ${repo.filter((m) => appliedSet.has(m)).length}`)
line(`  legacy slug rows   : ${legacyAliases.length}  (pre-convention history, not drift)`)
line(`  verified exceptions: ${LEGACY_RECONCILED.size}  (LEGACY_RECONCILED in migration-match.ts)`)
if (rich) line(`  convention since   : ${SINCE_VERSION}`)
line()

// ── violations ─────────────────────────────────────────────────────────────
let violations = 0

if (malformed.length) {
  violations += malformed.length
  line(`  ✗ ${malformed.length} migration file(s) with an unparseable prefix:`)
  for (const m of malformed) line(`      ${m}`)
  line(`    The drift watchdog cannot police a filename it cannot parse. Rename it.`)
  line()
}

if (notRecorded.length) {
  violations += notRecorded.length
  line(`  ✗ ${notRecorded.length} migration(s) with no ledger row of any shape:`)
  for (const n of notRecorded) line(`      ${n}`)
  line(`    Either genuinely unapplied, or applied without being recorded.`)
  line(`    Apply with scripts/apply-migration.mjs, which records atomically.`)
  line()
}

if (aliased.length) {
  violations += aliased.length
  line(`  ✗ ${aliased.length} migration(s) recorded under the wrong name AFTER ${SINCE_VERSION}:`)
  for (const a of aliased) {
    line(`      ${a.migration}`)
    line(`        recorded as "${a.recordedAs}"${a.version ? ` [${a.version}]` : ''}`)
  }
  line(`    Fix forward: insert an exact-name row with created_by`)
  line(`    "${RECONCILIATION_MARKER_PREFIX}<date>". Do not re-run the SQL.`)
  line()
}

// ── history: counted, never failed on ──────────────────────────────────────
if (legacyAliases.length) {
  line(`  · ${legacyAliases.length} migration(s) matched only by legacy slug, e.g.:`)
  for (const a of legacyAliases.slice(0, 5)) {
    line(`      ${a.migration} → "${a.recordedAs}"`)
  }
  if (legacyAliases.length > 5) line(`      … and ${legacyAliases.length - 5} more`)
  line(`    These predate the exact-filename convention and are cleared by the`)
  line(`    drift watchdog's slug fallback. Not drift; not re-recorded here.`)
  line()
}

if (dupes.length) {
  line(`  · ${dupes.length} name(s) recorded more than once:`)
  for (const d of dupes) {
    const where = rich ? ` (versions ${d.versions.join(', ')})` : ''
    line(`      ${d.name} ×${d.count}${where}`)
  }
  line()
}

if (unknownRows.length) {
  line(`  · ${unknownRows.length} ledger row(s) naming nothing in the repo:`)
  for (const r of unknownRows.slice(0, 8)) {
    line(`      ${r.name}${rich && r.version ? `  [${r.version}]` : ''}`)
  }
  if (unknownRows.length > 8) line(`      … and ${unknownRows.length - 8} more`)
  line()
}

if (!rich) {
  // Say plainly what was NOT checked. Silence here would be the same class of
  // overclaim as a drift watchdog that cannot parse half the filenames.
  line('  ⚠ names-only mode — these checks did NOT run:')
  line('      · post-convention alias detection (needs version), so a migration')
  line('        recorded under the wrong name TODAY is reported as legacy history')
  line('      · the created_by reconciliation exemption, so deliberate')
  line('        reconciliation rows appear as unknown history')
  line('      · which ledger versions a duplicate name occupies')
  line('    Apply supabase/migrations/20260902140000_applied_migration_ledger_rpc.sql')
  line('    to enable them.')
  line()
}

if (!violations) {
  line('  ✓ no identity violations: every migration is recorded, and nothing has')
  line(`    been recorded under a non-filename name since ${rich ? SINCE_VERSION : 'the convention took effect'}.`)
  line()
}

const strict = process.argv.includes('--strict')
process.exit(strict && violations ? 1 : 0)
