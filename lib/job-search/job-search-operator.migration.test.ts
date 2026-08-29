import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * Validates supabase/migrations/20260828z_job_search_operator_v1.sql
 * against a real embedded Postgres (same approach as every other
 * *.migration.test.ts in this repo, e.g.
 * lib/business-facts-atomic-write-rpc.migration.test.ts). Unlike those,
 * this migration is fully self-contained — no job_search_* table
 * references anything outside this migration (no workspace_id/customers
 * FK at all, by design) — so the whole file applies directly to a fresh
 * database with no stub schema needed first.
 *
 * This is the "migration/schema validation" check for CAY-192: it proves
 * the SQL actually runs, the seed rows land, the atomic profile-fact RPC's
 * row-lock chaining behaves exactly like write_business_fact_atomic's
 * (which it was modeled on), and the constraints this PR depends on for
 * safety (unique canonical_key, one application per candidate, CHECK
 * enums) are real and enforced — not just asserted in a comment.
 */
describe('job_search_operator_v1 migration (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    // The migration's job_search_write_profile_fact RPC revokes/grants
    // EXECUTE against anon/authenticated/service_role (see that block's
    // SECURITY comment in the migration) — those roles only exist in a
    // real Supabase Postgres instance, not a fresh PGlite database, so
    // they must be created first (same pattern as
    // business-facts-atomic-write-rpc.migration.test.ts).
    await db.exec(`
      do $$
      begin
        if not exists (select from pg_roles where rolname = 'anon') then
          create role anon;
        end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then
          create role authenticated;
        end if;
        if not exists (select from pg_roles where rolname = 'service_role') then
          create role service_role;
        end if;
      end
      $$;
    `)
    const migrationSql = readFileSync(
      join(__dirname, '..', '..', 'supabase', 'migrations', '20260828z_job_search_operator_v1.sql'),
      'utf8',
    )
    await db.exec(migrationSql)
  })

  afterAll(async () => {
    await db.close()
  })

  it('applies cleanly and creates every job_search_* table', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name like 'job_search_%' order by table_name`,
    )
    expect(rows.map((r) => r.table_name)).toEqual([
      'job_search_application_answers',
      'job_search_applications',
      'job_search_candidates',
      'job_search_events',
      'job_search_followups',
      'job_search_generated_artifacts',
      'job_search_profile_facts',
      'job_search_profiles',
      'job_search_resume_variants',
      'job_search_runs',
      'job_search_settings',
      'job_search_sources',
    ])
  })

  it('none of the job_search_* tables have a workspace_id column', async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name like 'job_search_%' and column_name = 'workspace_id'`,
    )
    expect(rows).toEqual([])
  })

  it('seeds exactly one NEEDS_VERIFICATION founder profile', async () => {
    const { rows } = await db.query<{ status: string; full_name: string }>(
      `select status, full_name from public.job_search_profiles`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('needs_verification')
    expect(rows[0].full_name).toMatch(/NEEDS_VERIFICATION/)
  })

  it('seeds all three resume variants', async () => {
    const { rows } = await db.query<{ variant_key: string }>(
      `select variant_key from public.job_search_resume_variants order by variant_key`,
    )
    expect(rows.map((r) => r.variant_key)).toEqual(['ai_llm', 'backend_platform', 'full_stack'])
  })

  it('seeds job_search_settings paused=true by default (fail-safe)', async () => {
    const { rows } = await db.query<{ paused: boolean }>(`select paused from public.job_search_settings`)
    expect(rows).toHaveLength(1)
    expect(rows[0].paused).toBe(true)
  })

  it('rejects an invalid job_search_candidates.status value', async () => {
    await expect(
      db.query(
        `insert into public.job_search_candidates (canonical_key, company, title, source_url, apply_url, status)
         values ('k1', 'Co', 'Title', 'http://x', 'http://x', 'NOT_A_REAL_STATUS')`,
      ),
    ).rejects.toThrow()
  })

  it('enforces unique canonical_key — a second insert with the same key is rejected', async () => {
    await db.query(
      `insert into public.job_search_candidates (canonical_key, company, title, source_url, apply_url)
       values ('dupe-key', 'Co', 'Title', 'http://x', 'http://x')`,
    )
    await expect(
      db.query(
        `insert into public.job_search_candidates (canonical_key, company, title, source_url, apply_url)
         values ('dupe-key', 'Other Co', 'Other Title', 'http://y', 'http://y')`,
      ),
    ).rejects.toThrow()
  })

  it('enforces one application per candidate (idempotency backbone)', async () => {
    const { rows: candidate } = await db.query<{ id: string }>(
      `insert into public.job_search_candidates (canonical_key, company, title, source_url, apply_url)
       values ('app-idem-key', 'Co', 'Title', 'http://x', 'http://x') returning id`,
    )
    await db.query(
      `insert into public.job_search_applications (candidate_id, idempotency_key) values ($1, 'k1')`,
      [candidate[0].id],
    )
    await expect(
      db.query(`insert into public.job_search_applications (candidate_id, idempotency_key) values ($1, 'k2')`, [candidate[0].id]),
    ).rejects.toThrow()
  })

  describe('job_search_write_profile_fact RPC — canonical-key row-lock chaining', () => {
    async function activeFacts(profileId: string) {
      const { rows } = await db.query<{ id: string; answer: string; canonical_key: string }>(
        `select id, answer, canonical_key from public.job_search_profile_facts where profile_id = $1 and superseded_at is null`,
        [profileId],
      )
      return rows
    }

    it('a second write for the same canonical_key supersedes the first — never two active for one key', async () => {
      const { rows: profile } = await db.query<{ id: string }>(`select id from public.job_search_profiles limit 1`)
      const profileId = profile[0].id

      await db.query(
        `select * from public.job_search_write_profile_fact($1, 'sponsorship-needed', 'work_authorization', 'Will you need visa sponsorship?', 'No, I have OPT/EAD.', 'founder-direct')`,
        [profileId],
      )
      await db.query(
        `select * from public.job_search_write_profile_fact($1, 'sponsorship-needed', 'work_authorization', 'Will you need visa sponsorship?', 'Updated answer.', 'founder-direct')`,
        [profileId],
      )

      const active = await activeFacts(profileId)
      expect(active).toHaveLength(1)
      expect(active[0].answer).toBe('Updated answer.')
    })

    it('a third correction chains onto the second, not the first', async () => {
      const { rows: profile } = await db.query<{ id: string }>(`select id from public.job_search_profiles limit 1`)
      const profileId = profile[0].id

      const r1 = await db.query<{ id: string }>(
        `select * from public.job_search_write_profile_fact($1, 'relocation', 'relocation', 'Open to relocation?', 'v1', 'founder-direct')`,
        [profileId],
      )
      const r2 = await db.query<{ id: string }>(
        `select * from public.job_search_write_profile_fact($1, 'relocation', 'relocation', 'Open to relocation?', 'v2', 'founder-direct')`,
        [profileId],
      )
      const r3 = await db.query<{ id: string }>(
        `select * from public.job_search_write_profile_fact($1, 'relocation', 'relocation', 'Open to relocation?', 'v3', 'founder-direct')`,
        [profileId],
      )
      const [v1, v2, v3] = [r1.rows[0].id, r2.rows[0].id, r3.rows[0].id]

      const { rows: all } = await db.query<{ id: string; superseded_by: string | null }>(
        `select id, superseded_by from public.job_search_profile_facts where profile_id = $1`,
        [profileId],
      )
      const byId = new Map(all.map((r) => [r.id, r.superseded_by]))
      expect(byId.get(v1)).toBe(v2)
      expect(byId.get(v2)).toBe(v3)
      expect(byId.get(v3)).toBeNull()
    })

    it('different canonical keys never interfere with each other', async () => {
      const { rows: profile } = await db.query<{ id: string }>(`select id from public.job_search_profiles limit 1`)
      const profileId = profile[0].id

      await db.query(
        `select * from public.job_search_write_profile_fact($1, 'clearance', 'clearance', 'Do you hold a clearance?', 'No.', 'founder-direct')`,
        [profileId],
      )
      await db.query(
        `select * from public.job_search_write_profile_fact($1, 'citizenship', 'citizenship', 'Are you a US citizen?', 'No, OPT/EAD.', 'founder-direct')`,
        [profileId],
      )
      // Reuses the same seeded profile as the earlier tests in this
      // describe block (by design — proving cross-key isolation on a
      // profile that already has other active facts), so assert presence
      // rather than an exact set.
      const active = await activeFacts(profileId)
      const keys = active.map((r) => r.canonical_key)
      expect(keys).toEqual(expect.arrayContaining(['citizenship', 'clearance']))
      expect(active.filter((r) => r.canonical_key === 'citizenship')).toHaveLength(1)
      expect(active.filter((r) => r.canonical_key === 'clearance')).toHaveLength(1)
    })
  })

  // Behavioral (not just structural) proof of the founder-isolation
  // invariant: job_search_write_profile_fact is SECURITY DEFINER, which
  // means it runs with the *owner's* privileges (and the owner's RLS
  // exemption) regardless of who calls it. Postgres grants EXECUTE on new
  // functions to PUBLIC by default, so without an explicit revoke, any
  // anon/authenticated Supabase client could call this RPC directly and
  // write founder profile facts despite RLS having zero policies on the
  // table. This audit found that gap (the migration originally had no
  // revoke/grant block at all — see PR #196 history) and closed it; this
  // test exercises the actual privilege boundary so a future regression
  // fails loudly instead of silently reopening the hole.
  describe('job_search_write_profile_fact — EXECUTE privilege boundary', () => {
    it('anon cannot call the RPC directly', async () => {
      const { rows: profile } = await db.query<{ id: string }>(`select id from public.job_search_profiles limit 1`)
      await db.query('set role anon')
      try {
        await expect(
          db.query(
            `select * from public.job_search_write_profile_fact($1, 'privilege-test-anon', 'general', 'q', 'a', 'founder-direct')`,
            [profile[0].id],
          ),
        ).rejects.toThrow(/permission denied/i)
      } finally {
        await db.query('reset role')
      }
    })

    it('authenticated cannot call the RPC directly', async () => {
      const { rows: profile } = await db.query<{ id: string }>(`select id from public.job_search_profiles limit 1`)
      await db.query('set role authenticated')
      try {
        await expect(
          db.query(
            `select * from public.job_search_write_profile_fact($1, 'privilege-test-auth', 'general', 'q', 'a', 'founder-direct')`,
            [profile[0].id],
          ),
        ).rejects.toThrow(/permission denied/i)
      } finally {
        await db.query('reset role')
      }
    })

    it('service_role can call the RPC (the only channel application code uses)', async () => {
      const { rows: profile } = await db.query<{ id: string }>(`select id from public.job_search_profiles limit 1`)
      await db.query('set role service_role')
      try {
        await expect(
          db.query(
            `select * from public.job_search_write_profile_fact($1, 'privilege-test-service', 'general', 'q', 'a', 'founder-direct')`,
            [profile[0].id],
          ),
        ).resolves.toBeDefined()
      } finally {
        await db.query('reset role')
      }
    })
  })
})
