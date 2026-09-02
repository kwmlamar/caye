import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PGlite } from '@electric-sql/pglite'

// Each transaction case builds a PGlite instance and replays generated SQL.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/**
 * The atomicity contract of scripts/apply-migration.mjs:
 *
 *     migration SQL commits  <=>  its exact ledger row commits
 *
 * A previous revision emitted `on conflict (version) do nothing` on the ledger
 * insert. That left one path open in the direction that matters: version
 * collides -> insert silently skipped -> transaction commits -> schema changed,
 * migration unrecorded. That is precisely the incident class the script exists
 * to prevent, so it gets a test that drives the real generated SQL against a
 * real Postgres and asserts the rollback, not just the absence of a string.
 */

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'apply-migration.mjs')

function generate(sqlBody: string, filename = '20260902150000_test_widget.sql') {
  const dir = mkdtempSync(join(tmpdir(), 'apply-migration-'))
  const path = join(dir, filename)
  writeFileSync(path, sqlBody)
  try {
    return execFileSync('node', [SCRIPT, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function generateExpectingFailure(sqlBody: string, filename: string) {
  const dir = mkdtempSync(join(tmpdir(), 'apply-migration-'))
  const path = join(dir, filename)
  writeFileSync(path, sqlBody)
  try {
    execFileSync('node', [SCRIPT, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return null
  } catch (err) {
    return String((err as { stderr?: Buffer }).stderr ?? '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const LEDGER = `
  create schema supabase_migrations;
  create table supabase_migrations.schema_migrations (
    version text primary key,
    name text,
    statements text[]
  );
`

const MIGRATION = `create table public.widget (id int primary key);`

function versionOf(sql: string): string {
  const m = sql.match(/values \(\s*'(\d{14})'/)
  if (!m) throw new Error('no version in generated SQL')
  return m[1]
}

describe('generated SQL — static guarantees', () => {
  const sql = generate(MIGRATION)

  it('contains no conflict clause on the ledger insert', () => {
    // The exact regression. Any form of it re-opens the hole.
    expect(sql.toLowerCase()).not.toContain('on conflict')
    expect(sql.toLowerCase()).not.toContain('do nothing')
    expect(sql.toLowerCase()).not.toContain('do update')
  })

  it('is not an upsert and does not overwrite another row', () => {
    expect(sql.toLowerCase()).not.toContain('update supabase_migrations')
    expect(sql.toLowerCase()).not.toContain('delete from supabase_migrations')
    expect(sql.toLowerCase()).not.toContain('merge into')
  })

  it('wraps exactly one transaction around body and ledger insert', () => {
    expect(sql.match(/^begin;$/gm)).toHaveLength(1)
    expect(sql.match(/^commit;$/gm)).toHaveLength(1)
    expect(sql.indexOf('begin;')).toBeLessThan(sql.indexOf('create table public.widget'))
    expect(sql.indexOf('create table public.widget')).toBeLessThan(
      sql.indexOf('insert into supabase_migrations.schema_migrations')
    )
    expect(sql.indexOf('insert into supabase_migrations.schema_migrations')).toBeLessThan(
      sql.lastIndexOf('commit;')
    )
  })

  it('records the name derived from the filename, and a 14-digit version', () => {
    expect(sql).toContain("'20260902150000_test_widget'")
    expect(versionOf(sql)).toMatch(/^\d{14}$/)
  })
})

describe('generated SQL — transaction semantics against Postgres', () => {
  it('commits the migration and its ledger row together', async () => {
    const db = new PGlite()
    try {
      await db.exec(LEDGER)
      await db.exec(generate(MIGRATION))

      const widget = await db.query<{ n: number }>(
        `select count(*)::int as n from pg_class
          where relname='widget' and relnamespace='public'::regnamespace`
      )
      expect(widget.rows[0].n).toBe(1)

      const ledger = await db.query<{ name: string }>(
        `select name from supabase_migrations.schema_migrations`
      )
      expect(ledger.rows.map((r) => r.name)).toEqual(['20260902150000_test_widget'])
    } finally {
      await db.close()
    }
  })

  it('a version collision aborts and rolls the migration back — no schema-only success', async () => {
    const db = new PGlite()
    try {
      await db.exec(LEDGER)
      const sql = generate(MIGRATION)

      // Occupy the version the generated SQL is about to claim.
      await db.query(
        `insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)`,
        [versionOf(sql), 'some_other_migration']
      )

      await expect(db.exec(sql)).rejects.toThrow(/duplicate key|unique constraint/i)

      // The error aborts the transaction block and exec stops before reaching
      // `commit;`, so the session is still inside it — exactly as psql or the
      // Supabase SQL editor would be. Clear it the way an operator would.
      await db.exec('rollback;')

      // THE ASSERTION THAT MATTERS: the schema change did not survive.
      const widget = await db.query<{ n: number }>(
        `select count(*)::int as n from pg_class
          where relname='widget' and relnamespace='public'::regnamespace`
      )
      expect(widget.rows[0].n, 'migration must be rolled back with the ledger insert').toBe(0)

      // …and the pre-existing ledger row was neither overwritten nor duplicated.
      const ledger = await db.query<{ name: string }>(
        `select name from supabase_migrations.schema_migrations`
      )
      expect(ledger.rows.map((r) => r.name)).toEqual(['some_other_migration'])
    } finally {
      await db.close()
    }
  })

  it('a failing migration body leaves no ledger row', async () => {
    // The other direction of the same invariant.
    const db = new PGlite()
    try {
      await db.exec(LEDGER)
      await db.exec(`create table public.widget (id int primary key);`) // force a conflict
      await expect(db.exec(generate(MIGRATION))).rejects.toThrow(/already exists/i)
      await db.exec('rollback;')

      const ledger = await db.query<{ n: number }>(
        `select count(*)::int as n from supabase_migrations.schema_migrations`
      )
      expect(ledger.rows[0].n, 'no row may be recorded for a migration that failed').toBe(0)
    } finally {
      await db.close()
    }
  })
})

describe('the script refuses inputs that would break atomicity', () => {
  it('rejects a body containing its own transaction control', () => {
    // A `commit;` inside the body would end the wrapper transaction early and
    // let the schema commit before the ledger insert ran.
    const stderr = generateExpectingFailure(
      `create table public.widget (id int);\ncommit;\ncreate table public.other (id int);`,
      '20260902150001_sneaky_commit.sql'
    )
    expect(stderr).toContain('contains its own transaction control')
  })

  it('does not false-positive on case…end; or function bodies', () => {
    const sql = generate(
      `alter table public.leads add column stage text;
       update public.leads set stage = case when status = 'won' then 'won' else 'open' end;
       create or replace function public.f() returns trigger language plpgsql as $$
       begin
         return new;
       end;
       $$;`,
      '20260902150002_case_and_function.sql'
    )
    expect(sql).toContain('20260902150002_case_and_function')
  })

  it('still refuses a hand-typed --name', () => {
    const stderr = generateExpectingFailure(MIGRATION, '20260902150003_named.sql')
    expect(stderr).toBeNull() // sanity: this file is fine on its own
    let threw = ''
    try {
      execFileSync('node', [SCRIPT, '--name=whatever', 'x.sql'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      threw = String((err as { stderr?: Buffer }).stderr ?? '')
    }
    expect(threw).toContain('there is no --name option')
  })
})
