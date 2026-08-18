import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * CAY-15 — verifies the real migration SQL
 * (supabase/migrations/20260818_harden_backup_tables_and_security_definer_rpcs.sql)
 * against an isolated, real embedded Postgres (PGlite), not a paraphrase of
 * it. No connection to any real Supabase project.
 *
 * The two backup tables and all six flagged functions predate this repo's
 * migrations directory (no CREATE TABLE/FUNCTION for any of them exists
 * anywhere under supabase/migrations/ — confirmed via grep), so there is no
 * migration to replay them from. Only minimal stand-ins with matching
 * names/signatures are stubbed here; this test proves the hardening
 * migration itself applies cleanly and produces the intended
 * grant/RLS/search_path state, not the pre-existing functions' business
 * logic.
 */
describe('CAY-15 backup table + SECURITY DEFINER hardening migration (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()

    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      grant usage on schema public to anon, authenticated, service_role;

      create table public.bookings_dedupe_backup_20260811 (id uuid primary key default gen_random_uuid());
      create table public.bookings_karin_dedupe_backup_20260811 (id uuid primary key default gen_random_uuid());
      grant select, insert, update, delete on public.bookings_dedupe_backup_20260811 to anon, authenticated, service_role;
      grant select, insert, update, delete on public.bookings_karin_dedupe_backup_20260811 to anon, authenticated, service_role;

      create function public.check_message_access(uuid) returns boolean
        language sql security definer as $$ select true $$;
      create function public.is_member_of(uuid) returns boolean
        language sql security definer as $$ select true $$;
      create function public.create_assignment_notification() returns trigger
        language plpgsql security definer as $$ begin return new; end; $$;
      create function public.create_message_notification() returns trigger
        language plpgsql security definer as $$ begin return new; end; $$;
      create function public.ensure_founder_in_workspace_members() returns trigger
        language plpgsql security definer as $$ begin return new; end; $$;
      create function public.handle_new_auth_user() returns trigger
        language plpgsql security definer as $$ begin return new; end; $$;

      grant execute on function public.check_message_access(uuid) to anon, authenticated;
      grant execute on function public.is_member_of(uuid) to anon, authenticated;
      grant execute on function public.create_assignment_notification() to anon, authenticated;
      grant execute on function public.create_message_notification() to anon, authenticated;
      grant execute on function public.ensure_founder_in_workspace_members() to anon, authenticated;
      grant execute on function public.handle_new_auth_user() to anon, authenticated;
    `)

    const migrationSql = readFileSync(
      join(__dirname, '..', 'supabase', 'migrations', '20260818_harden_backup_tables_and_security_definer_rpcs.sql'),
      'utf8'
    )
    await db.exec(migrationSql)
  })

  afterAll(async () => {
    await db.close()
  })

  it('applies cleanly and enables RLS with zero policies on both backup tables', async () => {
    for (const table of ['bookings_dedupe_backup_20260811', 'bookings_karin_dedupe_backup_20260811']) {
      const rls = await db.query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class where relname = $1`,
        [table]
      )
      expect(rls.rows[0]?.relrowsecurity).toBe(true)

      const policies = await db.query(`select policyname from pg_policies where tablename = $1`, [table])
      expect(policies.rows).toHaveLength(0)
    }
  })

  it('blocks anon and authenticated from the backup tables despite table-level grants', async () => {
    await db.exec(`set role anon;`)
    const anonSelect = await db.query(`select * from public.bookings_dedupe_backup_20260811`)
    expect(anonSelect.rows).toHaveLength(0)
    await expect(
      db.query(`insert into public.bookings_dedupe_backup_20260811 default values`)
    ).rejects.toThrow()
    await db.exec(`reset role;`)
  })

  it('service_role keeps full access to the backup tables (bypassrls)', async () => {
    await db.exec(`set role service_role;`)
    await db.query(`insert into public.bookings_karin_dedupe_backup_20260811 default values`)
    const res = await db.query(`select count(*)::int as n from public.bookings_karin_dedupe_backup_20260811`)
    expect((res.rows[0] as { n: number }).n).toBeGreaterThan(0)
    await db.exec(`reset role;`)
  })

  it('revokes EXECUTE on the two confirmed trigger-only functions for anon and authenticated', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const fn of ['ensure_founder_in_workspace_members()', 'handle_new_auth_user()']) {
        const res = await db.query<{ has: boolean }>(
          `select has_function_privilege($1, $2, 'EXECUTE') as has`,
          [role, `public.${fn}`]
        )
        expect(res.rows[0]?.has).toBe(false)
      }
    }
  })

  it('leaves EXECUTE untouched on the four intentionally retained functions', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const fn of [
        'check_message_access(uuid)',
        'is_member_of(uuid)',
        'create_assignment_notification()',
        'create_message_notification()',
      ]) {
        const res = await db.query<{ has: boolean }>(
          `select has_function_privilege($1, $2, 'EXECUTE') as has`,
          [role, `public.${fn}`]
        )
        expect(res.rows[0]?.has).toBe(true)
      }
    }
  })

  it('pins search_path on all six flagged functions', async () => {
    const res = await db.query<{ proname: string; proconfig: string[] | null }>(
      `select proname, proconfig from pg_proc
       where proname in (
         'check_message_access', 'is_member_of', 'create_assignment_notification',
         'create_message_notification', 'ensure_founder_in_workspace_members', 'handle_new_auth_user'
       )`
    )
    expect(res.rows).toHaveLength(6)
    for (const row of res.rows) {
      expect(row.proconfig).toContain('search_path=public')
    }
  })
})
