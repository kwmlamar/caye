import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseCheckConstraints, allowedValues, type ConstraintMap } from './check-constraints'
import { stripTsComments } from './strip-ts-comments'

/**
 * Guards the CHECK-constraint half of "a TypeScript literal the database
 * refuses", which produced four known failures in two days:
 *
 *   sender_type: 'system'   — a Postgres ENUM; db-enum-literals.test.ts covers it
 *   'booking_created'       — a CHECK constraint; nothing covered it, and no
 *                             operator was pinged about a booking from
 *                             2026-05-28 until it was found on 2026-08-12
 *   'operator_reminder'     — a CHECK constraint, same story
 *   'dropped_confirmation'  — a CHECK constraint, caught before it fired live
 *
 * db-enum-literals.test.ts now guards the outbound kinds, but by holding a
 * hand-written copy of the constraint's values. That copy can itself go stale:
 * widen the CHECK in a migration, forget the test, and the guard keeps passing
 * against a set the database no longer matches — failing in the same direction
 * as the bug it exists to catch. So the values here are read out of the
 * migrations, and the hand-written copy is checked against them.
 *
 * Verified 2026-08-12 against the live database: of the 33 constraints the
 * migrations define, the parser reproduced all 33 exactly, with zero
 * mismatches. (Prod has more CHECK constraints than this — tables predating
 * the migrations directory. Those are out of reach by construction, not by
 * oversight.)
 */

const repoRoot = process.cwd()
const MIGRATIONS_DIR = join(repoRoot, 'supabase/migrations')

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort() // filename order — later definitions of a column supersede earlier
  .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }))

const constraints: ConstraintMap = parseCheckConstraints(migrations)

describe('parsing CHECK constraints out of the migrations', () => {
  it('reads a meaningful number of constraints', () => {
    // Guards against the whole suite passing because the parser silently
    // returned nothing — which is exactly what a too-eager regex did on the
    // first attempt at this file (3 columns instead of 34).
    expect(migrations.length).toBeGreaterThan(50)
    expect(constraints.size).toBeGreaterThan(25)
  })

  it('resolves a constraint that was dropped and re-added to its latest form', () => {
    // caye_outbound_queue.kind said 'same_day_booking' from the very first
    // outbound migration until 20260812 replaced the constraint wholesale.
    // Later definition must win, or this guard would enforce the old shape.
    const kinds = allowedValues(constraints, 'caye_outbound_queue', 'kind')
    expect(kinds).not.toBeNull()
    expect(kinds!.has('booking_created')).toBe(true)
    expect(kinds!.has('same_day_booking')).toBe(false)
  })

  it('handles the value list spanning multiple lines', () => {
    // 20260812_fix_outbound_kind_check.sql writes its 13 values one per line.
    expect(allowedValues(constraints, 'caye_outbound_queue', 'kind')!.size).toBe(13)
  })

  it('handles both the IN (...) and = ANY (ARRAY[...]) forms', () => {
    // `check (status in (...))`
    expect(allowedValues(constraints, 'caye_pending_operations', 'status')).toEqual(
      new Set(['pending', 'synced', 'failed', 'dead_letter', 'cancelled'])
    )
    // `check (status = any (array[...::text]))` — casts stripped
    expect(allowedValues(constraints, 'customers', 'status')).toEqual(
      new Set(['trial', 'active', 'suspended', 'inactive'])
    )
  })

  it('reads the column out of an "is null or ..." constraint', () => {
    expect(allowedValues(constraints, 'business_fact_candidates', 'outcome')).toEqual(
      new Set(['confirmed', 'corrected', 'ignored'])
    )
  })

  it('scopes constraints to their table, so a shared column name cannot bleed', () => {
    // `source` is constrained on three different tables with three different
    // value sets. Merging them would make the guard useless.
    expect(allowedValues(constraints, 'bookings', 'source')).toEqual(
      new Set(['caye', 'manual', 'import', 'unknown'])
    )
    expect(allowedValues(constraints, 'business_facts', 'source')).toEqual(
      new Set(['owner-direct', 'escalation-capture', 'candidate-confirmed'])
    )
    expect(allowedValues(constraints, 'business_fact_candidates', 'source')).toEqual(
      new Set(['live_repeat', 'archive_mining'])
    )
  })

  it('does not invent constraints for enum columns', () => {
    // sender_type is a Postgres ENUM, not a CHECK. It belongs to
    // db-enum-literals.test.ts; claiming it here would double-guard it with
    // a second copy that could disagree.
    expect(allowedValues(constraints, 'unified_messages', 'sender_type')).toBeNull()
  })
})

describe('hand-written constraint copies stay in step with the migrations', () => {
  it('db-enum-literals.test.ts OUTBOUND_KIND_VALUES matches the live constraint', () => {
    // The drift this whole file exists to prevent. If a migration widens
    // caye_outbound_queue_kind_check and nobody updates that test, its guard
    // silently stops matching the database — so compare the two directly.
    const src = readFileSync(join(repoRoot, 'lib/db-enum-literals.test.ts'), 'utf8')
    const block = src.match(/OUTBOUND_KIND_VALUES\s*=\s*new Set\(\[([\s\S]*?)\]\)/)
    expect(block, 'OUTBOUND_KIND_VALUES not found — was it renamed?').not.toBeNull()

    const copied = new Set([...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]))
    const actual = allowedValues(constraints, 'caye_outbound_queue', 'kind')!

    expect(
      [...copied].sort(),
      'db-enum-literals.test.ts has drifted from caye_outbound_queue_kind_check'
    ).toEqual([...actual].sort())
  })
})

/**
 * Columns safe to scan for literals across the whole repo.
 *
 * Derived, not hand-listed: a column qualifies only if exactly one table
 * constrains it (so two tables sharing a name with different value sets can
 * never produce a false failure) and its name is distinctive enough that
 * `name: 'value'` in TypeScript is overwhelmingly likely to be that column.
 *
 * Generic names are excluded outright. `status`, `kind`, `role`, `category`,
 * `source` and `direction` appear constantly as unrelated object keys —
 * OperatorIntent.kind, metadata.kind, llm_call_log.source — and scanning them
 * would bury a real hit under noise. A guard that cries wolf gets ignored,
 * which is how these gaps survived weeks in the first place.
 */
const GENERIC_NAMES = new Set([
  'status', 'kind', 'role', 'category', 'source', 'direction', 'type',
  'action', 'effect', 'origin', 'priority', 'state', 'plan', 'visibility',
])

function scannableColumns(map: ConstraintMap): { column: string; values: Set<string> }[] {
  const byColumn = new Map<string, { tables: number; values: Set<string> }>()
  for (const [key, values] of map) {
    const column = key.split('.')[1]
    const entry = byColumn.get(column)
    if (entry) entry.tables += 1
    else byColumn.set(column, { tables: 1, values })
  }
  return [...byColumn.entries()]
    .filter(([column, e]) => e.tables === 1 && !GENERIC_NAMES.has(column) && column.includes('_'))
    .map(([column, e]) => ({ column, values: e.values }))
}

const ROOTS = ['lib', 'app', 'components', 'scripts']
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.git'])

function sourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

const files = ROOTS.flatMap((r) => sourceFiles(join(repoRoot, r)))

describe('literals written to CHECK-constrained columns', () => {
  const scannable = scannableColumns(constraints)

  it('has columns distinctive enough to scan', () => {
    expect(files.length).toBeGreaterThan(50)
    expect(scannable.length).toBeGreaterThan(3)
  })

  for (const { column, values } of scannable) {
    it(`only writes valid ${column} values`, () => {
      // `column: 'literal'` only. A value passed as a variable is the type
      // system's job, not this one's.
      const pattern = new RegExp(`\\b${column}:\\s*'([^']*)'`, 'g')
      const offenders: string[] = []

      for (const file of files) {
        // Comments blanked first — see lib/db/strip-ts-comments.ts. This
        // file's own doc comment names a rejected literal on purpose.
        const src = stripTsComments(readFileSync(file, 'utf8'))
        for (const m of src.matchAll(pattern)) {
          if (!values.has(m[1])) {
            const line = src.slice(0, m.index).split('\n').length
            offenders.push(`${file.replace(repoRoot + '/', '')}:${line} → ${column}: '${m[1]}'`)
          }
        }
      }

      expect(
        offenders,
        `Literal(s) the database's CHECK constraint rejects. Valid: ${[...values].join(', ')}\n` +
          offenders.join('\n')
      ).toEqual([])
    })
  }
})
