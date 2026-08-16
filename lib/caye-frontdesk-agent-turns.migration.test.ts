import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * Phase 3 (Part K) — verifies the real migration SQL
 * (supabase/migrations/20260816_caye_frontdesk_agent_turns.sql) against an
 * isolated, real embedded Postgres (PGlite), not a paraphrase of it. No
 * connection to any real Supabase project — this process never touches
 * production.
 *
 * What this DOES prove: the migration applies cleanly, constraints and
 * indexes exist and behave as intended, RLS is enabled with the
 * deny-by-default (zero-policy) shape the rest of this codebase uses for
 * service-role-only tables, and the idempotent-insert contract
 * (lib/caye-frontdesk-agent-turns.ts) actually relies on a real unique
 * constraint rather than an assumption about one.
 *
 * What this does NOT prove: true multi-backend/multi-connection
 * concurrency (PGlite is single-connection), Supabase's actual JWT→role
 * mapping (simulated here via `set role`, which is the same mechanism
 * Postgres RLS itself evaluates against — but the JWT/PostgREST layer
 * that produces that role is not exercised), or anything about
 * production data volume/performance.
 */
describe('caye_frontdesk_agent_turns migration (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()

    // Minimal stand-ins for the pre-existing tables this migration's FKs
    // target. Real `customers`/`unified_conversations`/`unified_messages`
    // predate this repo's migrations directory (created via the Supabase
    // dashboard — confirmed via `grep` finding no CREATE TABLE for any of
    // the three anywhere in supabase/migrations/), so there is no
    // migration file to replay them from. Only the columns this
    // migration's FKs and the app-layer joins actually need are stubbed.
    await db.exec(`
      create table public.customers (
        id uuid primary key default gen_random_uuid()
      );
      create table public.unified_conversations (
        id uuid primary key default gen_random_uuid()
      );
      create table public.unified_messages (
        id uuid primary key default gen_random_uuid(),
        conversation_id uuid not null references public.unified_conversations(id) on delete cascade
      );
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      grant all on all tables in schema public to service_role;
    `)

    const migrationSql = readFileSync(
      join(__dirname, '..', 'supabase', 'migrations', '20260816_caye_frontdesk_agent_turns.sql'),
      'utf8'
    )
    await db.exec(migrationSql)

    // Real Supabase grants anon/authenticated SELECT/INSERT/UPDATE/DELETE
    // at the GRANT level on every table by default — RLS is what actually
    // blocks them when a table has zero policies. Mirror that here so this
    // test proves the RLS layer is doing the work, not table-level GRANTs
    // this repo doesn't control per-table anyway. service_role's earlier
    // "all tables" grant predates this table's creation (the migration
    // ran after it), so it needs its own explicit grant here too —
    // BYPASSRLS bypasses row security, not table-level privileges.
    await db.exec(`
      grant all on public.caye_frontdesk_agent_turns to service_role;
      grant select, insert, update, delete on public.caye_frontdesk_agent_turns to anon, authenticated;
    `)
  })

  afterAll(async () => {
    await db.close()
  })

  it('applies cleanly and creates the table with RLS enabled', async () => {
    const res = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where relname = 'caye_frontdesk_agent_turns'`
    )
    expect(res.rows[0]?.relrowsecurity).toBe(true)
  })

  it('has zero RLS policies (deny-by-default, service-role-only)', async () => {
    const res = await db.query(
      `select policyname from pg_policies where tablename = 'caye_frontdesk_agent_turns'`
    )
    expect(res.rows).toHaveLength(0)
  })

  it('blocks anon and authenticated from reading or writing despite table-level grants', async () => {
    await db.exec(`set role service_role;`)
    const { rows: ws } = await db.query<{ id: string }>(`insert into public.customers default values returning id`)
    const { rows: convs } = await db.query<{ id: string }>(`insert into public.unified_conversations default values returning id`)
    await db.query(
      `insert into public.caye_frontdesk_agent_turns (workspace_id, conversation_id, sequence, role, claude_format)
       values ($1, $2, 0, 'user', '{"role":"user","content":"hi"}')`,
      [ws[0].id, convs[0].id]
    )
    await db.exec(`reset role;`)

    await db.exec(`set role anon;`)
    const anonSelect = await db.query(`select * from public.caye_frontdesk_agent_turns`)
    expect(anonSelect.rows).toHaveLength(0)
    await expect(
      db.query(
        `insert into public.caye_frontdesk_agent_turns (workspace_id, conversation_id, sequence, role, claude_format)
         values ($1, $2, 1, 'user', '{"role":"user","content":"nope"}')`,
        [ws[0].id, convs[0].id]
      )
    ).rejects.toThrow()
    await db.exec(`reset role;`)
  })

  it('service_role can read and write freely (bypassrls)', async () => {
    await db.exec(`set role service_role;`)
    const res = await db.query(`select count(*)::int as n from public.caye_frontdesk_agent_turns`)
    expect((res.rows[0] as { n: number }).n).toBeGreaterThan(0)
    await db.exec(`reset role;`)
  })

  it('enforces workspace isolation and cross-conversation isolation via the FK + query shape', async () => {
    await db.exec(`set role service_role;`)
    const { rows: wsA } = await db.query<{ id: string }>(`insert into public.customers default values returning id`)
    const { rows: wsB } = await db.query<{ id: string }>(`insert into public.customers default values returning id`)
    const { rows: convA } = await db.query<{ id: string }>(`insert into public.unified_conversations default values returning id`)
    const { rows: convB } = await db.query<{ id: string }>(`insert into public.unified_conversations default values returning id`)

    await db.query(
      `insert into public.caye_frontdesk_agent_turns (workspace_id, conversation_id, sequence, role, claude_format)
       values ($1, $2, 0, 'user', '{"role":"user","content":"A"}')`,
      [wsA[0].id, convA[0].id]
    )
    await db.query(
      `insert into public.caye_frontdesk_agent_turns (workspace_id, conversation_id, sequence, role, claude_format)
       values ($1, $2, 0, 'user', '{"role":"user","content":"B"}')`,
      [wsB[0].id, convB[0].id]
    )

    const onlyA = await db.query(
      `select claude_format->>'content' as content from public.caye_frontdesk_agent_turns where conversation_id = $1`,
      [convA[0].id]
    )
    expect(onlyA.rows).toEqual([{ content: 'A' }])

    const onlyB = await db.query(
      `select claude_format->>'content' as content from public.caye_frontdesk_agent_turns where workspace_id = $1`,
      [wsB[0].id]
    )
    expect(onlyB.rows).toEqual([{ content: 'B' }])
    await db.exec(`reset role;`)
  })

  it('rejects a duplicate (conversation_id, triggering_message_id, sequence) — the idempotency backstop', async () => {
    await db.exec(`set role service_role;`)
    const { rows: ws } = await db.query<{ id: string }>(`insert into public.customers default values returning id`)
    const { rows: conv } = await db.query<{ id: string }>(`insert into public.unified_conversations default values returning id`)
    const { rows: msg } = await db.query<{ id: string }>(
      `insert into public.unified_messages (conversation_id) values ($1) returning id`,
      [conv[0].id]
    )

    await db.query(
      `insert into public.caye_frontdesk_agent_turns (workspace_id, conversation_id, triggering_message_id, sequence, role, claude_format)
       values ($1, $2, $3, 0, 'user', '{"role":"user","content":"first"}')`,
      [ws[0].id, conv[0].id, msg[0].id]
    )

    await expect(
      db.query(
        `insert into public.caye_frontdesk_agent_turns (workspace_id, conversation_id, triggering_message_id, sequence, role, claude_format)
         values ($1, $2, $3, 0, 'user', '{"role":"user","content":"retry-duplicate"}')`,
        [ws[0].id, conv[0].id, msg[0].id]
      )
    ).rejects.toMatchObject({ code: '23505' })
    await db.exec(`reset role;`)
  })

  it('setting triggering_message_id to null on delete preserves the turn row (ON DELETE SET NULL)', async () => {
    await db.exec(`set role service_role;`)
    const { rows: ws } = await db.query<{ id: string }>(`insert into public.customers default values returning id`)
    const { rows: conv } = await db.query<{ id: string }>(`insert into public.unified_conversations default values returning id`)
    const { rows: msg } = await db.query<{ id: string }>(
      `insert into public.unified_messages (conversation_id) values ($1) returning id`,
      [conv[0].id]
    )
    const { rows: turn } = await db.query<{ id: string }>(
      `insert into public.caye_frontdesk_agent_turns (workspace_id, conversation_id, triggering_message_id, sequence, role, claude_format)
       values ($1, $2, $3, 5, 'assistant', '{"role":"assistant","content":"ok"}') returning id`,
      [ws[0].id, conv[0].id, msg[0].id]
    )

    await db.query(`delete from public.unified_messages where id = $1`, [msg[0].id])

    const after = await db.query<{ triggering_message_id: string | null }>(
      `select triggering_message_id from public.caye_frontdesk_agent_turns where id = $1`,
      [turn[0].id]
    )
    expect(after.rows[0]?.triggering_message_id).toBeNull()
    await db.exec(`reset role;`)
  })

  it('cascades delete when the parent workspace (customers row) is removed', async () => {
    await db.exec(`set role service_role;`)
    const { rows: ws } = await db.query<{ id: string }>(`insert into public.customers default values returning id`)
    const { rows: conv } = await db.query<{ id: string }>(`insert into public.unified_conversations default values returning id`)
    await db.query(
      `insert into public.caye_frontdesk_agent_turns (workspace_id, conversation_id, sequence, role, claude_format)
       values ($1, $2, 0, 'user', '{"role":"user","content":"cascade-me"}')`,
      [ws[0].id, conv[0].id]
    )

    await db.query(`delete from public.customers where id = $1`, [ws[0].id])

    const after = await db.query(
      `select 1 from public.caye_frontdesk_agent_turns where workspace_id = $1`,
      [ws[0].id]
    )
    expect(after.rows).toHaveLength(0)
    await db.exec(`reset role;`)
  })
})
