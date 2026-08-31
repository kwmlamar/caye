import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * Validates supabase/migrations/20260831_job_search_live_submission.sql against
 * a real embedded Postgres, applied on top of the migrations it depends on.
 *
 * The properties under test are the ones that bound real-world blast radius:
 * the daily cap ceiling, the atomic batch-slot consume, and the privilege
 * boundary on the new SECURITY DEFINER function. These are asserted
 * BEHAVIORALLY — by trying the thing and observing the database refuse — not
 * by grepping the SQL text.
 */
const MIGRATIONS = join(__dirname, '..', '..', '..', 'supabase', 'migrations')

describe('job_search_live_submission migration (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      do $$
      begin
        if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end
      $$;
    `)
    for (const file of [
      '20260828z_job_search_operator_v1.sql',
      '20260829b_job_search_application_execution.sql',
      '20260829c_job_search_browser_execution.sql',
      '20260830a_cap_job_search_browser_submission_to_three.sql',
      '20260831_job_search_live_submission.sql',
    ]) {
      await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
    }
  })

  afterAll(async () => { await db?.close() })

  describe('the daily-cap ceiling is generalized, not deleted', () => {
    it('accepts the production policy maximum of 150', async () => {
      await expect(db.exec('update public.job_search_execution_settings set daily_submission_cap = 150 where id = true')).resolves.toBeDefined()
    })

    it('still refuses anything above the hard maximum', async () => {
      await expect(db.exec('update public.job_search_execution_settings set daily_submission_cap = 151 where id = true')).rejects.toThrow()
      await expect(db.exec('update public.job_search_execution_settings set daily_submission_cap = 1500 where id = true')).rejects.toThrow()
    })

    it('still refuses a negative cap', async () => {
      await expect(db.exec('update public.job_search_execution_settings set daily_submission_cap = -1 where id = true')).rejects.toThrow()
    })
  })

  describe('consequential-action evidence columns exist on every attempt', () => {
    it('carries the click timestamps, destination, reservation and hashes', async () => {
      const result = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'job_search_execution_attempts'`,
      )
      const columns = result.rows.map((r) => r.column_name)
      for (const expected of [
        'destination_url', 'claim_token', 'submission_reservation_id', 'submit_clicked_at', 'submit_observed_at',
        'result_url', 'confirmation_method', 'confirmation_signals', 'resume_artifact_sha256', 'answer_set_sha256',
        'batch_authorization_id',
      ]) {
        expect(columns).toContain(expected)
      }
    })
  })

  describe('batch authorizations are bounded, expiring, and atomically consumed', () => {
    beforeAll(async () => {
      await db.exec(`
        insert into public.job_search_batch_authorizations (id, created_by, provider, max_applications, min_score, expires_at)
        values ('11111111-1111-1111-1111-111111111111', 'founder', 'greenhouse', 3, 70, now() + interval '1 hour');
      `)
    })

    it('refuses a non-positive or over-ceiling authorization', async () => {
      await expect(db.exec(`insert into public.job_search_batch_authorizations (created_by, provider, max_applications, expires_at) values ('f','greenhouse',0, now() + interval '1 hour')`)).rejects.toThrow()
      await expect(db.exec(`insert into public.job_search_batch_authorizations (created_by, provider, max_applications, expires_at) values ('f','greenhouse',151, now() + interval '1 hour')`)).rejects.toThrow()
    })

    it('consumes exactly max_applications slots and then refuses', async () => {
      const results: boolean[] = []
      for (let i = 0; i < 5; i++) {
        const r = await db.query<{ consume_job_search_batch_slot: boolean }>(
          `select public.consume_job_search_batch_slot('11111111-1111-1111-1111-111111111111'::uuid, 'greenhouse')`,
        )
        results.push(r.rows[0].consume_job_search_batch_slot)
      }
      expect(results.filter(Boolean)).toHaveLength(3)
      expect(results.slice(3)).toEqual([false, false])
    })

    it('refuses a slot for a different provider than authorized', async () => {
      await db.exec(`insert into public.job_search_batch_authorizations (id, created_by, provider, max_applications, expires_at) values ('22222222-2222-2222-2222-222222222222','founder','greenhouse',5, now() + interval '1 hour')`)
      const r = await db.query<{ consume_job_search_batch_slot: boolean }>(
        `select public.consume_job_search_batch_slot('22222222-2222-2222-2222-222222222222'::uuid, 'lever')`,
      )
      expect(r.rows[0].consume_job_search_batch_slot).toBe(false)
    })

    it('refuses a slot from an expired authorization', async () => {
      await db.exec(`insert into public.job_search_batch_authorizations (id, created_by, provider, max_applications, expires_at) values ('33333333-3333-3333-3333-333333333333','founder','greenhouse',5, now() - interval '1 minute')`)
      const r = await db.query<{ consume_job_search_batch_slot: boolean }>(
        `select public.consume_job_search_batch_slot('33333333-3333-3333-3333-333333333333'::uuid, 'greenhouse')`,
      )
      expect(r.rows[0].consume_job_search_batch_slot).toBe(false)
    })

    it('refuses a slot from a revoked authorization', async () => {
      await db.exec(`insert into public.job_search_batch_authorizations (id, created_by, provider, max_applications, expires_at, revoked_at) values ('44444444-4444-4444-4444-444444444444','founder','greenhouse',5, now() + interval '1 hour', now())`)
      const r = await db.query<{ consume_job_search_batch_slot: boolean }>(
        `select public.consume_job_search_batch_slot('44444444-4444-4444-4444-444444444444'::uuid, 'greenhouse')`,
      )
      expect(r.rows[0].consume_job_search_batch_slot).toBe(false)
    })

    it('refuses a slot for an unknown authorization', async () => {
      const r = await db.query<{ consume_job_search_batch_slot: boolean }>(
        `select public.consume_job_search_batch_slot('55555555-5555-5555-5555-555555555555'::uuid, 'greenhouse')`,
      )
      expect(r.rows[0].consume_job_search_batch_slot).toBe(false)
    })
  })

  describe('privilege boundary on the new SECURITY DEFINER function', () => {
    it('is not executable by anon or authenticated, only service_role', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`)
        await expect(
          db.query(`select public.consume_job_search_batch_slot('11111111-1111-1111-1111-111111111111'::uuid, 'greenhouse')`),
        ).rejects.toThrow()
        await db.exec('reset role')
      }

      await db.exec('set role service_role')
      await expect(
        db.query(`select public.consume_job_search_batch_slot('11111111-1111-1111-1111-111111111111'::uuid, 'greenhouse')`),
      ).resolves.toBeDefined()
      await db.exec('reset role')
    })

    it('has a pinned search_path', async () => {
      const r = await db.query<{ proconfig: string[] | null }>(
        `select proconfig from pg_proc where proname = 'consume_job_search_batch_slot'`,
      )
      expect(r.rows[0].proconfig?.join(',')).toMatch(/search_path/)
    })
  })

  describe('batch authorization table is deny-by-default', () => {
    it('has RLS enabled with zero policies (service-role-only)', async () => {
      const rls = await db.query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class where relname = 'job_search_batch_authorizations'`,
      )
      expect(rls.rows[0].relrowsecurity).toBe(true)

      const policies = await db.query<{ count: string }>(
        `select count(*)::text as count from pg_policies where tablename = 'job_search_batch_authorizations'`,
      )
      expect(policies.rows[0].count).toBe('0')
    })
  })
})
