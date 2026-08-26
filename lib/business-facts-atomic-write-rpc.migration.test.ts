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
    // Contradiction-handling hardening pass: scopes canonical-key chaining
    // by service_id (see that migration's own header for the real
    // production case — pink building vs. Casino Tram Stop — that motivated
    // it). Applied on top, same as it would be in a real deploy.
    const scopeFixSql = readFileSync(
      join(__dirname, '..', 'supabase', 'migrations', '20260826d_business_facts_canonical_key_scope_by_service.sql'),
      'utf8'
    )
    await db.exec(scopeFixSql)
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

  // Real production case (2026-08-26 historical-learning audit, second
  // pass): "the meeting point for the Heritage Tour is the pink building by
  // the dock" (service-scoped) and "the pickup location for all tours is
  // the Casino Tram Stop" (workspace-wide) are BOTH still active in real
  // Bimini data today, un-reconciled. If a classifier ever assigned the
  // SAME canonical_key to both (a realistic mistake, not the norm), the
  // pre-fix chain would have silently superseded one with the other purely
  // because the key string matched — regardless of the very different
  // scope. This proves the fix: same canonical_key, different scope, never
  // auto-chains.
  it('a workspace-wide fact and a service-scoped fact sharing the SAME canonical_key never chain/supersede each other', async () => {
    const ws = await makeWorkspace()
    const { rows: svc } = await db.query<{ id: string }>(`insert into public.booking_services default values returning id`)
    const heritageServiceId = svc[0].id

    await db.query(
      `select * from public.write_business_fact_atomic($1, 'logistics', 'The meeting point for the Heritage Tour is the pink building by the dock.', 'owner-direct', 'owner', $2, 'pickup-location')`,
      [ws, heritageServiceId]
    )
    await db.query(
      `select * from public.write_business_fact_atomic($1, 'logistics', 'The pickup location for all tours is the Casino Tram Stop.', 'owner-direct', 'owner', null, 'pickup-location')`,
      [ws]
    )

    // Both still active — a shared canonical_key string alone did NOT
    // collapse them, because they're in different scopes.
    const active = await activeFacts(ws)
    expect(active).toHaveLength(2)
    expect(active.map((r) => r.fact).sort()).toEqual(
      [
        'The meeting point for the Heritage Tour is the pink building by the dock.',
        'The pickup location for all tours is the Casino Tram Stop.',
      ].sort()
    )
  })

  it('the scoped chain still correctly supersedes within the SAME scope (service-scoped correcting service-scoped)', async () => {
    const ws = await makeWorkspace()
    const { rows: svc } = await db.query<{ id: string }>(`insert into public.booking_services default values returning id`)
    const heritageServiceId = svc[0].id

    const r1 = await db.query<{ id: string }>(
      `select * from public.write_business_fact_atomic($1, 'logistics', 'The Heritage Tour meets at the pink building by the dock.', 'owner-direct', 'owner', $2, 'heritage-meeting-point')`,
      [ws, heritageServiceId]
    )
    const r2 = await db.query<{ id: string }>(
      `select * from public.write_business_fact_atomic($1, 'logistics', 'The Heritage Tour now meets at the Casino Tram Stop.', 'owner-direct', 'owner', $2, 'heritage-meeting-point')`,
      [ws, heritageServiceId]
    )

    const active = await activeFacts(ws)
    expect(active).toHaveLength(1)
    expect(active[0].id).toBe(r2.rows[0].id)

    const { rows: oldRow } = await db.query<{ superseded_by: string | null }>(
      `select superseded_by from public.business_facts where id = $1`,
      [r1.rows[0].id]
    )
    expect(oldRow[0].superseded_by).toBe(r2.rows[0].id)
  })

  it('the scoped chain still correctly supersedes within workspace-wide scope (workspace-wide correcting workspace-wide)', async () => {
    const ws = await makeWorkspace()
    await db.query(
      `select * from public.write_business_fact_atomic($1, 'logistics', 'The pickup for all tours is the Marina dock.', 'owner-direct', 'owner', null, 'pickup-location')`,
      [ws]
    )
    await db.query(
      `select * from public.write_business_fact_atomic($1, 'logistics', 'The pickup location for all tours is the Casino Tram Stop.', 'owner-direct', 'owner', null, 'pickup-location')`,
      [ws]
    )
    const active = await activeFacts(ws)
    expect(active).toHaveLength(1)
    expect(active[0].fact).toBe('The pickup location for all tours is the Casino Tram Stop.')
  })

  it('an explicit p_supersede_id can still cross the scope boundary — a judged contradiction is not blocked by the scoping fix', async () => {
    const ws = await makeWorkspace()
    const { rows: svc } = await db.query<{ id: string }>(`insert into public.booking_services default values returning id`)
    const heritageServiceId = svc[0].id

    const oldRow = await db.query<{ id: string }>(
      `select * from public.write_business_fact_atomic($1, 'logistics', 'The meeting point for the Heritage Tour is the pink building by the dock.', 'owner-direct', 'owner', $2, 'heritage-meeting-point')`,
      [ws, heritageServiceId]
    )
    // A DIFFERENT canonical_key this time, but the conflict judge explicitly
    // identified oldRow as the contradiction target (p_supersede_id) — this
    // must still work; only the coincidental-key-match path is scoped.
    const newRow = await db.query<{ id: string }>(
      `select * from public.write_business_fact_atomic($1, 'logistics', 'All tours now meet at the Casino Tram Stop.', 'owner-direct', 'owner', null, 'all-tours-pickup', null, $2)`,
      [ws, oldRow.rows[0].id]
    )
    const active = await activeFacts(ws)
    expect(active).toHaveLength(1)
    expect(active[0].id).toBe(newRow.rows[0].id)
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
    await db.exec(
      readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20260826d_business_facts_canonical_key_scope_by_service.sql'), 'utf8')
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
