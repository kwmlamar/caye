import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * Operator Learning Router — verifies
 * supabase/migrations/20260826_business_facts_scope_and_canonical_key.sql
 * against a real embedded Postgres. The important property under test is
 * the canonical-key row-lock chain: two (or more) writes for the SAME
 * (workspace, canonical_key) must never leave two facts simultaneously
 * active — this is how the router stays safe against duplicate webhook
 * delivery and near-simultaneous corrections from two operators WITHOUT a
 * cross-call advisory lock (unsafe here — see the migration's own header).
 *
 * PGlite is single-connection, so a true parallel race isn't reproducible
 * here — what IS verified is that the SQL's row-locking logic produces the
 * correct serialized outcome when called sequentially, which is the same
 * code path real concurrent callers would each execute (Postgres's row lock
 * itself is what would serialize them under real concurrency; this test
 * exercises the logic that lock protects).
 *
 * Same read-only, no-production-connection approach as
 * business-facts-supersede-rpc.migration.test.ts.
 */
describe('write_business_fact_atomic RPC (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table public.customers (id uuid primary key default gen_random_uuid());
      create table public.booking_services (id uuid primary key default gen_random_uuid());
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
      join(__dirname, '..', 'supabase', 'migrations', '20260826_business_facts_scope_and_canonical_key.sql'),
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

  async function activeFacts(ws: string): Promise<{ id: string; fact: string; canonical_key: string | null }[]> {
    const { rows } = await db.query<{ id: string; fact: string; canonical_key: string | null }>(
      `select id, fact, canonical_key from public.business_facts where workspace_id = $1 and superseded_at is null`,
      [ws]
    )
    return rows
  }

  it('plain insert with no canonical_key just appends (back-compat with the un-keyed shape)', async () => {
    const ws = await makeWorkspace()
    await db.query(
      `select * from public.write_business_fact_atomic($1, 'policy', 'The dock closes at 5pm.', 'owner-direct', 'owner')`,
      [ws]
    )
    expect(await activeFacts(ws)).toHaveLength(1)
  })

  it('a second write for the SAME canonical_key supersedes the first — never two active for one key', async () => {
    const ws = await makeWorkspace()
    await db.query(
      `select * from public.write_business_fact_atomic($1, 'policy', 'We accept cash, Zelle, or card.', 'owner-direct', 'owner', null, 'payment-method')`,
      [ws]
    )
    await db.query(
      `select * from public.write_business_fact_atomic($1, 'policy', 'We only use online payment.', 'owner-direct', 'owner', null, 'payment-method')`,
      [ws]
    )
    const active = await activeFacts(ws)
    expect(active).toHaveLength(1)
    expect(active[0].fact).toBe('We only use online payment.')
  })

  it('a THIRD correction on the same canonical_key chains onto the SECOND, not the first — proving the lock target moves forward each time', async () => {
    const ws = await makeWorkspace()
    const r1 = await db.query<{ id: string }>(
      `select * from public.write_business_fact_atomic($1, 'policy', 'v1', 'owner-direct', 'owner', null, 'k')`,
      [ws]
    )
    const r2 = await db.query<{ id: string }>(
      `select * from public.write_business_fact_atomic($1, 'policy', 'v2', 'owner-direct', 'owner', null, 'k')`,
      [ws]
    )
    const r3 = await db.query<{ id: string }>(
      `select * from public.write_business_fact_atomic($1, 'policy', 'v3', 'owner-direct', 'owner', null, 'k')`,
      [ws]
    )
    const [v1Id, v2Id, v3Id] = [r1.rows[0].id, r2.rows[0].id, r3.rows[0].id]

    const active = await activeFacts(ws)
    expect(active).toHaveLength(1)
    expect(active[0].id).toBe(v3Id)

    // Full chain preserved for audit: v1 -> v2 -> v3, never a gap or a fork.
    // These are sequential, awaited calls — each RPC invocation completes
    // before the next begins — so the chain is fully deterministic: v2's
    // call locks whichever row is active for canonical_key 'k' at that
    // moment (v1, since it hasn't been superseded yet) and supersedes it;
    // v3's call does the same against v2.
    const { rows: all } = await db.query<{ id: string; superseded_by: string | null }>(
      `select id, superseded_by from public.business_facts where workspace_id = $1`,
      [ws]
    )
    const byId = new Map(all.map((r) => [r.id, r.superseded_by]))
    expect(byId.get(v1Id)).toBe(v2Id)
    expect(byId.get(v2Id)).toBe(v3Id)
    expect(byId.get(v3Id)).toBeNull()
  })

  it('different canonical_keys never interfere with each other', async () => {
    const ws = await makeWorkspace()
    await db.query(
      `select * from public.write_business_fact_atomic($1, 'policy', 'Bottled water is $2.50/guest.', 'owner-direct', 'owner', null, 'bottled-water-price')`,
      [ws]
    )
    await db.query(
      `select * from public.write_business_fact_atomic($1, 'policy', 'We only use online payment.', 'owner-direct', 'owner', null, 'payment-method')`,
      [ws]
    )
    const active = await activeFacts(ws)
    expect(active).toHaveLength(2)
  })

  it('an explicit p_supersede_id still works for a conflict outside the canonical-key chain (e.g. an older un-keyed fact)', async () => {
    const ws = await makeWorkspace()
    const { rows: oldRows } = await db.query<{ id: string }>(
      `insert into public.business_facts (workspace_id, category, fact, source, created_by) values ($1, 'policy', 'Cash only.', 'owner-direct', 'owner') returning id`,
      [ws]
    )
    const oldId = oldRows[0].id

    await db.query(
      `select * from public.write_business_fact_atomic($1, 'policy', 'We only use online payment.', 'owner-direct', 'owner', null, 'payment-method', null, $2)`,
      [ws, oldId]
    )
    const active = await activeFacts(ws)
    expect(active).toHaveLength(1)
    expect(active[0].fact).toBe('We only use online payment.')

    const { rows: oldRow } = await db.query<{ superseded_at: string | null }>(
      `select superseded_at from public.business_facts where id = $1`,
      [oldId]
    )
    expect(oldRow[0].superseded_at).not.toBeNull()
  })

  it('service_id is recorded when supplied and survives the write', async () => {
    const ws = await makeWorkspace()
    const { rows: svc } = await db.query<{ id: string }>(`insert into public.booking_services default values returning id`)
    const { rows } = await db.query<{ id: string }>(
      `select * from public.write_business_fact_atomic($1, 'logistics', 'Meets at the pink building.', 'owner-direct', 'owner', $2, 'heritage-meeting-point')`,
      [ws, svc[0].id]
    )
    const { rows: saved } = await db.query<{ service_id: string }>(
      `select service_id from public.business_facts where id = $1`,
      [rows[0].id]
    )
    expect(saved[0].service_id).toBe(svc[0].id)
  })

  it('cross-workspace explicit supersede id is still rejected (same guarantee as the existing RPC)', async () => {
    const wsA = await makeWorkspace()
    const wsB = await makeWorkspace()
    const { rows: foreign } = await db.query<{ id: string }>(
      `insert into public.business_facts (workspace_id, category, fact, source, created_by) values ($1, 'policy', 'Parking is free.', 'owner-direct', 'owner') returning id`,
      [wsB]
    )
    await expect(
      db.query(
        `select * from public.write_business_fact_atomic($1, 'policy', 'Parking now costs $10.', 'owner-direct', 'owner', null, 'parking', null, $2)`,
        [wsA, foreign[0].id]
      )
    ).rejects.toThrow(/does not belong to workspace/)
    expect(await activeFacts(wsA)).toHaveLength(0)
  })
})

/**
 * Fresh-context retrieval proof: runs the EXACT query shape
 * lib/business-facts.ts's fetchBusinessFacts uses (workspace_id match,
 * superseded_at is null, ordered by created_at) against real Postgres,
 * completely independent of any conversation history or in-memory state —
 * this is what makes a router-written fact answer a brand-new customer
 * thread days later, not a mock standing in for real durability.
 */
describe('fresh-context retrieval — the fetchBusinessFacts query shape', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table public.customers (id uuid primary key default gen_random_uuid());
      create table public.booking_services (id uuid primary key default gen_random_uuid());
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
      alter table public.business_facts add column superseded_by uuid references public.business_facts (id) on delete set null;
      alter table public.business_facts add column superseded_at timestamptz;
      do $$
      begin
        if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end
      $$;
    `)
    await db.exec(
      readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20260826_business_facts_scope_and_canonical_key.sql'), 'utf8')
    )
  })

  afterAll(async () => {
    await db.close()
  })

  it('a router-written fact is retrievable by fetchBusinessFacts-shaped query — a brand-new customer thread sees it', async () => {
    const { rows: ws } = await db.query<{ id: string }>(`insert into public.customers default values returning id`)
    const workspaceId = ws[0].id

    await db.query(
      `select * from public.write_business_fact_atomic($1, 'service_detail', 'Bottled water is $2.50 per guest, one bottle per person.', 'owner-direct', 'owner', null, 'bottled-water-price')`,
      [workspaceId]
    )

    // The exact filter fetchBusinessFacts (lib/business-facts.ts) runs —
    // no reference to the conversation, thread, or message that produced
    // the fact. A fresh SQL connection with only workspace_id in hand.
    const { rows } = await db.query<{ id: string; category: string; fact: string }>(
      `select id, category, fact from public.business_facts
       where workspace_id = $1 and superseded_at is null
       order by created_at asc limit 150`,
      [workspaceId]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].fact).toBe('Bottled water is $2.50 per guest, one bottle per person.')
  })

  it('after a correction, the SAME fresh query returns only the current fact — never both as equally valid', async () => {
    const { rows: ws } = await db.query<{ id: string }>(`insert into public.customers default values returning id`)
    const workspaceId = ws[0].id

    await db.query(
      `select * from public.write_business_fact_atomic($1, 'policy', 'We accept cash, Zelle, or card.', 'owner-direct', 'owner', null, 'payment-method')`,
      [workspaceId]
    )
    await db.query(
      `select * from public.write_business_fact_atomic($1, 'policy', 'We only use online payment.', 'owner-direct', 'owner', null, 'payment-method')`,
      [workspaceId]
    )

    const { rows } = await db.query<{ fact: string }>(
      `select fact from public.business_facts where workspace_id = $1 and superseded_at is null order by created_at asc limit 150`,
      [workspaceId]
    )
    expect(rows.map((r) => r.fact)).toEqual(['We only use online payment.'])
  })
})
