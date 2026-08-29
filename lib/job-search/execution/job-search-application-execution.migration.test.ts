import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * Validates supabase/migrations/20260829b_job_search_application_execution.sql
 * against a real embedded Postgres, applied on top of #196's original
 * 20260828z_job_search_operator_v1.sql migration (same approach as
 * lib/job-search/job-search-operator.migration.test.ts) — this migration
 * ALTERs tables that migration creates, so it cannot be validated alone.
 *
 * No new SECURITY DEFINER RPC is added by this migration (see its own doc
 * comment), so there is no new privilege-boundary behavior to test here
 * beyond what job-search-operator.migration.test.ts already covers for
 * job_search_write_profile_fact.
 */
describe('job_search_application_execution migration (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
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
    const baseMigration = readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'migrations', '20260828z_job_search_operator_v1.sql'), 'utf8')
    await db.exec(baseMigration)
    const executionMigration = readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'migrations', '20260829b_job_search_application_execution.sql'), 'utf8')
    await db.exec(executionMigration)
  })

  afterAll(async () => {
    await db.close()
  })

  it('applies cleanly and creates both new tables', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('job_search_execution_attempts', 'job_search_execution_settings') order by table_name`,
    )
    expect(rows.map((r) => r.table_name)).toEqual(['job_search_execution_attempts', 'job_search_execution_settings'])
  })

  it('neither new table has a workspace_id column', async () => {
    const { rows } = await db.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name in ('job_search_execution_attempts', 'job_search_execution_settings') and column_name = 'workspace_id'`,
    )
    expect(rows).toEqual([])
  })

  it('seeds job_search_execution_settings fully disabled by default', async () => {
    const { rows } = await db.query<{ automation_enabled: boolean; dry_run: boolean; daily_submission_cap: number; emergency_paused: boolean }>(
      `select automation_enabled, dry_run, daily_submission_cap, emergency_paused from public.job_search_execution_settings`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].automation_enabled).toBe(false)
    expect(rows[0].dry_run).toBe(true)
    expect(rows[0].daily_submission_cap).toBe(3)
    expect(rows[0].emergency_paused).toBe(false)
  })

  it('job_search_applications now accepts SUBMISSION_UNCERTAIN as a status', async () => {
    const { rows: candidate } = await db.query<{ id: string }>(
      `insert into public.job_search_candidates (canonical_key, company, title, source_url, apply_url) values ('exec-key-1', 'Co', 'Title', 'http://x', 'http://x') returning id`,
    )
    await expect(
      db.query(
        `insert into public.job_search_applications (candidate_id, idempotency_key, status) values ($1, 'exec-idem-1', 'SUBMISSION_UNCERTAIN')`,
        [candidate[0].id],
      ),
    ).resolves.toBeDefined()
  })

  it('job_search_applications still rejects an invalid status', async () => {
    const { rows: candidate } = await db.query<{ id: string }>(
      `insert into public.job_search_candidates (canonical_key, company, title, source_url, apply_url) values ('exec-key-2', 'Co', 'Title', 'http://x', 'http://x') returning id`,
    )
    await expect(
      db.query(`insert into public.job_search_applications (candidate_id, idempotency_key, status) values ($1, 'exec-idem-2', 'NOT_A_REAL_STATUS')`, [candidate[0].id]),
    ).rejects.toThrow()
  })

  it('job_search_application_answers now accepts application_specific as an answer_source', async () => {
    const { rows: candidate } = await db.query<{ id: string }>(
      `insert into public.job_search_candidates (canonical_key, company, title, source_url, apply_url) values ('exec-key-3', 'Co', 'Title', 'http://x', 'http://x') returning id`,
    )
    const { rows: application } = await db.query<{ id: string }>(
      `insert into public.job_search_applications (candidate_id, idempotency_key) values ($1, 'exec-idem-3') returning id`,
      [candidate[0].id],
    )
    await expect(
      db.query(
        `insert into public.job_search_application_answers (application_id, question, answer, answer_source) values ($1, 'q', 'a', 'application_specific')`,
        [application[0].id],
      ),
    ).resolves.toBeDefined()
  })

  it('job_search_execution_attempts enforces unique (application_id, attempt_number)', async () => {
    const { rows: candidate } = await db.query<{ id: string }>(
      `insert into public.job_search_candidates (canonical_key, company, title, source_url, apply_url) values ('exec-key-4', 'Co', 'Title', 'http://x', 'http://x') returning id`,
    )
    const { rows: application } = await db.query<{ id: string }>(
      `insert into public.job_search_applications (candidate_id, idempotency_key) values ($1, 'exec-idem-4') returning id`,
      [candidate[0].id],
    )
    await db.query(
      `insert into public.job_search_execution_attempts (application_id, attempt_number, provider, dry_run, outcome) values ($1, 1, 'greenhouse', true, 'needs_human')`,
      [application[0].id],
    )
    await expect(
      db.query(
        `insert into public.job_search_execution_attempts (application_id, attempt_number, provider, dry_run, outcome) values ($1, 1, 'greenhouse', true, 'needs_human')`,
        [application[0].id],
      ),
    ).rejects.toThrow()
  })

  it('job_search_execution_attempts rejects an invalid outcome', async () => {
    const { rows: candidate } = await db.query<{ id: string }>(
      `insert into public.job_search_candidates (canonical_key, company, title, source_url, apply_url) values ('exec-key-5', 'Co', 'Title', 'http://x', 'http://x') returning id`,
    )
    const { rows: application } = await db.query<{ id: string }>(
      `insert into public.job_search_applications (candidate_id, idempotency_key) values ($1, 'exec-idem-5') returning id`,
      [candidate[0].id],
    )
    await expect(
      db.query(
        `insert into public.job_search_execution_attempts (application_id, attempt_number, provider, dry_run, outcome) values ($1, 1, 'greenhouse', true, 'not_a_real_outcome')`,
        [application[0].id],
      ),
    ).rejects.toThrow()
  })

  it('job_search_profiles has the new contact_email/contact_phone columns', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema='public' and table_name='job_search_profiles' and column_name in ('contact_email','contact_phone') order by column_name`,
    )
    expect(rows.map((r) => r.column_name)).toEqual(['contact_email', 'contact_phone'])
  })
})
