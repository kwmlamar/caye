import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

// Each case builds one or more full PGlite instances and replays real
// migrations; that comfortably exceeds the 5s default when the suite runs
// these files in parallel with the rest.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/**
 * Regression cover for the latent digest() defect.
 *
 * The whole point is that `create function` SUCCEEDING proves nothing here.
 * plpgsql resolves function names at execution time, so
 * record_caye_recommendation_decision and upsert_grounded_caye_recommendation
 * were created cleanly by their migrations and then threw 42883 on every
 * single real call — silently, because nothing exercised them. Both tables sat
 * empty for a day and the migration ledger said "applied".
 *
 * So these tests CALL the functions. The first one asserts the original
 * migration is genuinely broken (if that ever stops being true the forward fix
 * is pointless and should be reconsidered); the rest assert the forward
 * migration makes real calls work, without changing signature, behaviour or
 * privileges.
 *
 * The fixture reproduces production's extension layout exactly: pgcrypto in
 * `extensions`, not `public`. Installing it into `public` would make every one
 * of these tests pass against the broken code, which is precisely how this
 * defect stayed invisible.
 */

const MIGRATIONS = join(__dirname, '..', '..', 'supabase', 'migrations')
const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8')

/** Tables the two functions touch, plus the roles their grants name. */
const FIXTURE = `
  create schema if not exists extensions;
  create extension if not exists pgcrypto with schema extensions;
  create role anon; create role authenticated; create role service_role;

  create table public.customers (id uuid primary key default gen_random_uuid());
  create table public.caye_goals (id uuid primary key default gen_random_uuid());
  create table public.research_claims (id uuid primary key default gen_random_uuid());
  create table public.intelligence_items (
    id uuid primary key default gen_random_uuid(), confidence numeric
  );
  create table public.intelligence_belief_revisions (
    id uuid primary key default gen_random_uuid(), revised_confidence numeric
  );
  create table public.intelligence_item_claims (
    intelligence_item_id uuid not null, claim_id uuid not null
  );
  create table public.intelligence_belief_revision_claims (
    revision_id uuid not null, claim_id uuid not null
  );
`

async function freshDb() {
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(FIXTURE)
  await db.exec(read('20260901010500_canonical_evidence_backed_recommendations.sql'))
  await db.exec(read('20260901012000_canonical_recommendation_decisions.sql'))
  return db
}

/** A recommendation row inserted directly, so the decision test does not
 *  depend on the (separately broken) upsert function. */
async function seedRecommendation(db: PGlite) {
  const { rows } = await db.query<{ id: string }>(`
    insert into public.caye_goals default values returning id
  `)
  const goalId = rows[0].id
  const { rows: rec } = await db.query<{ id: string }>(
    `insert into public.caye_recommendations
       (scope, workspace_id, goal_id, title, recommendation, rationale, confidence,
        expected_impact, urgency, reversibility, risk_classification,
        required_authority, fingerprint, provenance)
     values ('operator', null, $1, 'Title', 'Do the thing', 'Because', 0.5,
             'Impact', 'medium', 'easy', 'low', '{}'::jsonb, 'seed-fingerprint', '{}'::jsonb)
     returning id`,
    [goalId]
  )
  return rec[0].id
}

describe('digest() resolution under search_path = public', () => {
  it('pgcrypto lives in extensions, exactly as production has it', async () => {
    const db = await freshDb()
    try {
      const { rows } = await db.query<{ nspname: string }>(
        `select distinct n.nspname from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where p.proname = 'digest'`
      )
      expect(rows.map((r) => r.nspname)).toEqual(['extensions'])
    } finally {
      await db.close()
    }
  })

  it('the ORIGINAL applied migration creates a function that throws when called', async () => {
    // This is the test that would have caught it. CREATE succeeds; the call
    // does not.
    const db = await freshDb()
    try {
      const recommendationId = await seedRecommendation(db)

      const created = await db.query<{ n: number }>(
        `select count(*)::int as n from pg_proc
          where proname = 'record_caye_recommendation_decision'`
      )
      expect(created.rows[0].n).toBe(1) // created cleanly — the misleading part

      await expect(
        db.query(
          `select public.record_caye_recommendation_decision($1, 'accepted', 'founder')`,
          [recommendationId]
        )
      ).rejects.toThrow(/function digest\(.*\) does not exist/)
    } finally {
      await db.close()
    }
  })

  it('the forward migration makes the same call succeed', async () => {
    const db = await freshDb()
    try {
      const recommendationId = await seedRecommendation(db)
      await db.exec(read('20260902120000_fix_recommendation_digest_resolution.sql'))

      const { rows } = await db.query<{ id: string; decision: string; fingerprint: string }>(
        `select * from public.record_caye_recommendation_decision($1, 'accepted', 'founder')`,
        [recommendationId]
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('accepted')
      expect(rows[0].fingerprint).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await db.close()
    }
  })

  it('the fix is idempotent and does not disturb rows written before it', async () => {
    const db = await freshDb()
    try {
      const recommendationId = await seedRecommendation(db)
      await db.exec(read('20260902120000_fix_recommendation_digest_resolution.sql'))
      const first = await db.query<{ id: string }>(
        `select id from public.record_caye_recommendation_decision($1, 'accepted', 'founder')`,
        [recommendationId]
      )

      // applying it a second time must be a no-op
      await db.exec(read('20260902120000_fix_recommendation_digest_resolution.sql'))

      const after = await db.query<{ n: number }>(
        `select count(*)::int as n from public.caye_recommendation_decisions`
      )
      expect(after.rows[0].n).toBe(1)
      const still = await db.query<{ id: string }>(
        `select id from public.caye_recommendation_decisions`
      )
      expect(still.rows[0].id).toBe(first.rows[0].id)
    } finally {
      await db.close()
    }
  })

  it('preserves the signature the deployed code calls', async () => {
    const db = await freshDb()
    try {
      const before = await db.query<{ args: string; secdef: boolean; cfg: string[] | null }>(
        `select pg_get_function_identity_arguments(oid) as args,
                prosecdef as secdef, proconfig as cfg
           from pg_proc where proname = 'record_caye_recommendation_decision'`
      )
      await db.exec(read('20260902120000_fix_recommendation_digest_resolution.sql'))
      const after = await db.query<{ args: string; secdef: boolean; cfg: string[] | null }>(
        `select pg_get_function_identity_arguments(oid) as args,
                prosecdef as secdef, proconfig as cfg
           from pg_proc where proname = 'record_caye_recommendation_decision'`
      )
      expect(after.rows[0].args).toBe(before.rows[0].args)
      // SECURITY DEFINER and the narrow search_path are unchanged: the fix
      // qualifies one call site, it does not widen name resolution.
      expect(after.rows[0].secdef).toBe(true)
      expect(after.rows[0].cfg).toEqual(['search_path=public'])
    } finally {
      await db.close()
    }
  })

  it.each([
    'record_caye_recommendation_decision',
    'upsert_grounded_caye_recommendation',
  ])('leaves %s executable by service_role only', async (proname) => {
    const db = await freshDb()
    try {
      await db.exec(read('20260902120000_fix_recommendation_digest_resolution.sql'))
      const { rows } = await db.query<{ role: string }>(
        `select r.rolname as role
           from pg_proc p, pg_roles r
          where p.proname = $1
            and r.rolname in ('anon','authenticated','service_role')
            and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
        [proname]
      )
      expect(rows.map((r) => r.role).sort()).toEqual(['service_role'])
    } finally {
      await db.close()
    }
  })

  /**
   * The two files below are ALREADY APPLIED and are deliberately not edited;
   * 20260902120000 carries their correction forward. They are named here as
   * explicit, asserted exceptions rather than left to a looser regex, so a
   * NEW bare-digest call site cannot hide among them.
   */
  const FIXED_FORWARD_NOT_IN_PLACE = [
    '20260901010500_canonical_evidence_backed_recommendations.sql',
    '20260901012000_canonical_recommendation_decisions.sql',
  ]

  /** Bodies of `create ... function ... as $tag$ … $tag$`, nothing else. */
  function functionBodies(sql: string): string[] {
    const bodies: string[] = []
    const re = /\bas\s+(\$[A-Za-z_]*\$)([\s\S]*?)\1/g
    let m: RegExpExecArray | null
    while ((m = re.exec(sql))) bodies.push(m[2])
    return bodies
  }

  function bareDigestSites(sql: string): string[] {
    const hits: string[] = []
    for (const body of functionBodies(sql)) {
      for (const line of body.split('\n')) {
        if (line.trim().startsWith('--')) continue
        if (/(?<![.\w])digest\s*\(/.test(line)) hits.push(line.trim())
      }
    }
    return hits
  }

  it('only top-level statements may call digest() unqualified', () => {
    // A bare digest() in a top-level statement resolves against the applier's
    // own search_path and is fine. Inside a function body declared
    // `set search_path = public` it is a latent 42883 waiting for the first
    // real call — which is the defect this whole file exists for.
    const sql = read('20260830b_research_runtime_integrity.sql')
    expect(bareDigestSites(sql)).toEqual([]) // its digest() is top-level
    expect(sql).toContain("encode(digest(canonical_url")
  })

  it('no function body in any migration calls digest() unqualified', async () => {
    const { readdirSync } = await import('node:fs')
    const offenders: Record<string, string[]> = {}
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
      if (FIXED_FORWARD_NOT_IN_PLACE.includes(file)) continue
      const hits = bareDigestSites(read(file))
      if (hits.length) offenders[file] = hits
    }
    expect(offenders).toEqual({})
  })

  it.each(FIXED_FORWARD_NOT_IN_PLACE)(
    '%s is still broken in place, and the forward migration covers it',
    (file) => {
      // If this ever stops finding a bare call, the file was edited in place —
      // which rewrites applied history and must not happen silently.
      expect(bareDigestSites(read(file)).length).toBeGreaterThan(0)
    }
  )

  it('the forward migration redefines exactly the functions left unfixed in place', () => {
    const forward = read('20260902120000_fix_recommendation_digest_resolution.sql')
    for (const file of FIXED_FORWARD_NOT_IN_PLACE) {
      const names = [...read(file).matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/g)]
        .map((m) => m[1])
      const withBareDigest = names.filter((n) => read(file).includes(n))
      expect(withBareDigest.length).toBeGreaterThan(0)
      for (const name of names) {
        expect(forward).toContain(`create or replace function public.${name}(`)
      }
    }
    expect(bareDigestSites(forward)).toEqual([])
  })
})
