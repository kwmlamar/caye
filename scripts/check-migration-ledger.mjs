#!/usr/bin/env node
/**
 * Read-only audit of the migration ledger against the repo.
 *
 * Enforces one invariant:
 *
 *     repo migration identity == recorded migration identity
 *
 * with explicit reconciliation metadata as the only exception. It reads the
 * ledger through the existing service-role-only `applied_migration_names` RPC
 * and writes nothing.
 *
 *     node scripts/check-migration-ledger.mjs            # audit
 *     node scripts/check-migration-ledger.mjs --strict   # exit 1 on any finding
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, from the
 * environment or .env.local. Without them it audits nothing and says so rather
 * than pretending to pass — a check that silently no-ops is how the last one
 * went unnoticed.
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

const MIGRATION_PREFIX = /^\d{8}(?:\d{2}|\d{4}|\d{6})?[a-z]{0,2}_/
const slugOf = (n) => n.replace(MIGRATION_PREFIX, '')
const RECONCILIATION_MARKER_PREFIX = 'migration-drift-reconciliation-'

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

const res = await fetch(`${url}/rest/v1/rpc/applied_migration_names`, {
  method: 'POST',
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: '{}',
})
if (!res.ok) {
  console.error(`\n  ✗ applied_migration_names failed: ${res.status} ${await res.text()}\n`)
  process.exit(1)
}
const applied = await res.json()
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

for (const migration of repo) {
  if (appliedSet.has(migration)) continue
  const aliases = (bySlug.get(slugOf(migration)) ?? []).filter((n) => n !== migration)
  if (aliases.length) aliased.push({ migration, recordedAs: aliases[0] })
  else notRecorded.push(migration)
}

for (const name of new Set(applied)) {
  if (repoSet.has(name)) continue
  if (bySlug.has(name) && repo.some((m) => slugOf(m) === name)) continue // legacy slug alias
  unknownRows.push(name)
}

const dupes = [...applied.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map())]
  .filter(([, n]) => n > 1)
  .map(([name, count]) => ({ name, count }))

// ── report ─────────────────────────────────────────────────────────────────
const line = (s = '') => console.log(s)
line()
line(`  migrations on disk   : ${repo.length}`)
line(`  ledger rows          : ${applied.length} (${new Set(applied).size} distinct names)`)
line(`  exact-name matches   : ${repo.filter((m) => appliedSet.has(m)).length}`)
line()

let findings = 0

if (malformed.length) {
  findings += malformed.length
  line(`  ✗ ${malformed.length} migration file(s) with an unparseable prefix:`)
  for (const m of malformed) line(`      ${m}`)
  line()
}

if (aliased.length) {
  findings += aliased.length
  line(`  ✗ ${aliased.length} migration(s) recorded under a name that is not the filename:`)
  for (const a of aliased) line(`      ${a.migration}\n        recorded as "${a.recordedAs}"`)
  line(`    Fix forward: insert an exact-name row with created_by`)
  line(`    "${RECONCILIATION_MARKER_PREFIX}<date>". Do not re-run the SQL.`)
  line()
}

if (dupes.length) {
  findings += dupes.length
  line(`  ! ${dupes.length} name(s) recorded more than once:`)
  for (const d of dupes) line(`      ${d.name} ×${d.count}`)
  line()
}

if (notRecorded.length) {
  line(`  ! ${notRecorded.length} migration(s) with no ledger row of any shape:`)
  for (const n of notRecorded) line(`      ${n}`)
  line(`    Either genuinely unapplied, or applied without being recorded.`)
  line(`    Apply with scripts/apply-migration.mjs, which records atomically.`)
  line()
}

if (unknownRows.length) {
  line(`  · ${unknownRows.length} ledger row(s) naming nothing in the repo (pre-convention history):`)
  for (const n of unknownRows.slice(0, 10)) line(`      ${n}`)
  if (unknownRows.length > 10) line(`      … and ${unknownRows.length - 10} more`)
  line()
}

if (!findings && !notRecorded.length) {
  line('  ✓ every repo migration is recorded under its exact filename.')
  line()
}

const strict = process.argv.includes('--strict')
process.exit(strict && (findings || notRecorded.length) ? 1 : 0)
