import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Does caye_outbound_queue_kind_check actually match OutboundKind?
 *
 * WHY THIS EXISTS (2026-08-12)
 * lib/db-enum-literals.test.ts's enqueueOutbound check compares call-site
 * literals against a hardcoded OUTBOUND_KIND_VALUES Set — a set someone has
 * to remember to update by hand every time the constraint changes. That is
 * the exact same failure mode that caused the bug it exists to catch:
 * 'booking_created' has been silently rejected by the database since the
 * very first outbound migration (2026-05-28, wrote 'same_day_booking'
 * instead), and this constraint has been patched by hand — and drifted from
 * the TS union again — at least three separate times since: 2026-06-26,
 * 2026-08-05, and twice more on 2026-08-11/12 finding this very bug. A
 * hand-maintained mirror doesn't stop that; it just relocates where the next
 * drift goes unnoticed.
 *
 * This reads BOTH sides live from their actual sources every run, so there
 * is nothing to remember to keep in sync:
 *
 *   - the TS side: parsed straight out of the `OutboundKind` union in
 *     lib/whatsapp/outbound.ts
 *   - the SQL side: parsed out of the LATEST migration file that touches
 *     caye_outbound_queue_kind_check
 *
 * WHY "THE LATEST FILE" IS ENOUGH — NO NEED TO REPLAY HISTORY
 * Every migration that has ever touched this constraint (2026-06-26,
 * 2026-08-05, 2026-08-12) does `drop constraint if exists ... ; add
 * constraint ... check (...)` — a full redefinition, not an incremental
 * patch. So the most recent one fully describes the constraint's current
 * shape; nothing needs merging across files. If a future migration ever
 * patches the constraint incrementally instead of drop+recreate, this test
 * would silently read a stale definition — which is exactly the kind of
 * regression the "latest file has no matches" and "found file, but parsed
 * zero values" guards below are there to catch. Requires no live DB
 * connection: this codebase has no raw Postgres connection string, only the
 * Supabase REST client, which does not expose pg_catalog — so "read the
 * newest migration" is not a workaround, it's the only offline option, and
 * it happens to be sufficient given how these migrations are actually
 * written.
 */

const repoRoot = process.cwd()
const CONSTRAINT_NAME = 'caye_outbound_queue_kind_check'

function latestMigrationTouching(constraintName: string): { file: string; content: string } | null {
  const dir = join(repoRoot, 'supabase', 'migrations')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort() // filenames are YYYYMMDD[-letter]_description.sql — lexical sort is chronological

  let latest: { file: string; content: string } | null = null
  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf8')
    if (content.includes(constraintName)) latest = { file, content }
  }
  return latest
}

/**
 * Pull every quoted value out of the `check (kind ...);` statement.
 *
 * Deliberately does not try to match IN(...) vs = ANY(ARRAY[...]) bracket
 * structure precisely — Postgres accepts either, and different migrations in
 * this repo's own history use both. Since the only quoted strings that ever
 * appear inside a real `check (kind ...)` statement are the allowed values
 * themselves, grabbing every quoted token in that span is exactly as
 * accurate as parsing the bracket structure, for a fraction of the
 * complexity and false-negative risk.
 */
function valuesFromConstraintSQL(sql: string): string[] {
  const stmt = sql.match(/check\s*\(\s*kind\b[\s\S]*?;/i)
  if (!stmt) return []
  return [...stmt[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

/** Pull every `| 'x'` union member out of OutboundKind — ignores comments. */
function outboundKindUnionValues(): string[] {
  const src = readFileSync(join(repoRoot, 'lib', 'whatsapp', 'outbound.ts'), 'utf8')
  const block = src.match(/export type OutboundKind =\s*([\s\S]*?)\n\nexport interface/)
  if (!block) return []
  return [...block[1].matchAll(/^\s*\|\s*'([a-z_]+)'/gm)].map((m) => m[1])
}

describe('caye_outbound_queue_kind_check stays in sync with OutboundKind', () => {
  it('finds a migration that defines the constraint', () => {
    // If this fails, either the constraint was renamed/dropped for good
    // reason (update CONSTRAINT_NAME) or the migrations directory moved.
    expect(latestMigrationTouching(CONSTRAINT_NAME)).not.toBeNull()
  })

  it('parses a non-empty value list out of that migration', () => {
    const latest = latestMigrationTouching(CONSTRAINT_NAME)!
    const values = valuesFromConstraintSQL(latest.content)
    // A parse regression (e.g. a future migration writes the constraint in
    // a shape this can't read) must fail loudly, not silently pass with an
    // empty list that trivially "matches" nothing.
    expect(values.length).toBeGreaterThan(5)
  })

  it('parses a non-empty OutboundKind union', () => {
    expect(outboundKindUnionValues().length).toBeGreaterThan(5)
  })

  it('the two sides list exactly the same kinds', () => {
    const latest = latestMigrationTouching(CONSTRAINT_NAME)!
    const sqlValues = new Set(valuesFromConstraintSQL(latest.content))
    const tsValues = new Set(outboundKindUnionValues())

    const inTsNotSql = [...tsValues].filter((v) => !sqlValues.has(v))
    const inSqlNotTs = [...sqlValues].filter((v) => !tsValues.has(v))

    expect(
      { missingFromDB: inTsNotSql, missingFromCode: inSqlNotTs, latestMigration: latest.file },
      inTsNotSql.length
        ? `OutboundKind has a kind no migration allows — every enqueueOutbound ` +
          `call with it will be silently rejected. Add it to ${latest.file} ` +
          `(or a new migration, following the same drop+add pattern).`
        : inSqlNotTs.length
          ? `The DB allows a kind OutboundKind doesn't know about — probably ` +
            `harmless (nothing can enqueue it), but check whether a TS kind ` +
            `was renamed and the old value should be dropped from the constraint.`
          : ''
    ).toEqual({ missingFromDB: [], missingFromCode: [], latestMigration: latest.file })
  })

  it('rejects the exact drift that broke booking_created for two and a half months', () => {
    const latest = latestMigrationTouching(CONSTRAINT_NAME)!
    const sqlValues = new Set(valuesFromConstraintSQL(latest.content))
    expect(sqlValues.has('same_day_booking')).toBe(false)
    expect(sqlValues.has('booking_created')).toBe(true)
  })
})
