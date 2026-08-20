import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * CAY-14 follow-up (2026-08-19) — verifies
 * supabase/migrations/20260819_business_facts_supersede_rpc.sql against a
 * real embedded Postgres. add_business_fact and confirm_fact_candidate used
 * to write a replacement as two independent Supabase calls (insert, then
 * update); a failure on the update left the old and new fact both active —
 * exactly the incident CAY-14 exists to prevent. This RPC folds both writes
 * into one Postgres function call, which is atomic: any raised exception
 * inside it rolls back every effect, so there is no path that leaves a new
 * fact inserted with its target un-superseded, or vice versa.
 *
 * Same read-only, no-production-connection approach as
 * lib/caye-pending-actions-supersession.migration.test.ts — the fixture
 * recreates just enough of business_facts (as of 20260807h/20260818) to
 * apply the migration under test.
 */
describe('add_business_fact_with_supersession RPC (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table public.customers (id uuid primary key default gen_random_uuid());
      create table public.business_facts (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references public.customers(id) on delete cascade,
        category text not null check (category in ('policy', 'service_detail', 'special_handling', 'logistics')),
        fact text not null,
        source text not null default 'owner-direct' check (source in ('owner-direct', 'escalation-capture', 'candidate-confirmed')),
        created_by text,
        expires_at timestamptz,
        created_at timestamptz not null default now()
      );
      alter table public.business_facts
        add column superseded_by uuid references public.business_facts (id) on delete set null;
      alter table public.business_facts
        add column superseded_at timestamptz;

      -- Supabase's built-in roles, referenced by the migration's grant/revoke
      -- statements. Plain postgres/PGlite has no such roles by default.
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
      join(__dirname, '..', 'supabase', 'migrations', '20260819_business_facts_supersede_rpc.sql'),
      'utf8'
    )
    await db.exec(migrationSql)
  })

  afterAll(async () => {
    await db.close()
  })

  async function makeWorkspace(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(`insert into public.customers default values returning id`)
    return rows[0].id
  }

  async function insertFact(ws: string, fact: string, source = 'owner-direct'): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.business_facts (workspace_id, category, fact, source, created_by)
       values ($1, 'policy', $2, $3, 'owner') returning id`,
      [ws, fact, source]
    )
    return rows[0].id
  }

  async function factCount(ws: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.business_facts where workspace_id = $1`,
      [ws]
    )
    return Number(rows[0].count)
  }

  it('plain insert with no supersede target just appends', async () => {
    const ws = await makeWorkspace()
    const { rows } = await db.query<{ id: string; created_at: string }>(
      `select * from public.add_business_fact_with_supersession($1, 'policy', 'The dock closes at 5pm.', 'owner-direct', 'owner')`,
      [ws]
    )
    expect(rows).toHaveLength(1)
    expect(await factCount(ws)).toBe(1)
  })

  it('successful supersession: new row active, old row marked superseded with audit text preserved, retrieval sees only the new fact', async () => {
    const ws = await makeWorkspace()
    const oldText = 'All payments are made in advance by card only... Cash and Zelle are not accepted.'
    const oldId = await insertFact(ws, oldText)

    const { rows } = await db.query<{ id: string; created_at: string }>(
      `select * from public.add_business_fact_with_supersession($1, 'policy', $2, 'owner-direct', 'owner', null, $3)`,
      [ws, 'Cash is fine with Max — do not mention payment method unless asked.', oldId]
    )
    const newId = rows[0].id

    const { rows: oldRow } = await db.query<{ fact: string; superseded_by: string | null; superseded_at: string | null }>(
      `select fact, superseded_by, superseded_at from public.business_facts where id = $1`,
      [oldId]
    )
    expect(oldRow[0].fact).toBe(oldText) // audit: original text untouched
    expect(oldRow[0].superseded_by).toBe(newId)
    expect(oldRow[0].superseded_at).not.toBeNull()

    const { rows: active } = await db.query<{ id: string }>(
      `select id from public.business_facts where workspace_id = $1 and superseded_at is null`,
      [ws]
    )
    expect(active.map((r) => r.id)).toEqual([newId]) // normal retrieval sees only the new fact
  })

  it('DB-level failure (unknown supersede target) leaves no dual-active facts: nothing is inserted and no row is mutated', async () => {
    const ws = await makeWorkspace()
    const before = await factCount(ws)

    await expect(
      db.query(
        `select * from public.add_business_fact_with_supersession($1, 'policy', 'Cash is fine now.', 'owner-direct', 'owner', null, $2)`,
        [ws, '00000000-0000-0000-0000-000000000099']
      )
    ).rejects.toThrow(/not found/)

    expect(await factCount(ws)).toBe(before) // no orphaned insert
  })

  it('cross-workspace supersede id is rejected: the target workspace fact is untouched and no new fact is inserted', async () => {
    const wsA = await makeWorkspace()
    const wsB = await makeWorkspace()
    const foreignFactId = await insertFact(wsB, 'Parking is free at the north lot.')

    await expect(
      db.query(
        `select * from public.add_business_fact_with_supersession($1, 'policy', 'Parking now costs $10/day.', 'owner-direct', 'owner', null, $2)`,
        [wsA, foreignFactId]
      )
    ).rejects.toThrow(/does not belong to workspace/)

    expect(await factCount(wsA)).toBe(0) // nothing leaked into workspace A
    const { rows: foreign } = await db.query<{ superseded_at: string | null }>(
      `select superseded_at from public.business_facts where id = $1`,
      [foreignFactId]
    )
    expect(foreign[0].superseded_at).toBeNull() // workspace B's fact untouched by workspace A's attempt
  })

  it('supersede target that is already superseded is rejected — no double-supersession, no orphaned insert', async () => {
    const ws = await makeWorkspace()
    const oldId = await insertFact(ws, 'Tours run daily at 9am.')
    const firstReplacement = await db.query<{ id: string }>(
      `select * from public.add_business_fact_with_supersession($1, 'policy', 'Tours run daily at 10am.', 'owner-direct', 'owner', null, $2)`,
      [ws, oldId]
    )
    const before = await factCount(ws)

    await expect(
      db.query(
        `select * from public.add_business_fact_with_supersession($1, 'policy', 'Tours run daily at 11am.', 'owner-direct', 'owner', null, $2)`,
        [ws, oldId]
      )
    ).rejects.toThrow(/already superseded/)

    expect(await factCount(ws)).toBe(before)
    const { rows: oldRow } = await db.query<{ superseded_by: string }>(
      `select superseded_by from public.business_facts where id = $1`,
      [oldId]
    )
    expect(oldRow[0].superseded_by).toBe(firstReplacement.rows[0].id) // still points at the FIRST replacement
  })
})
