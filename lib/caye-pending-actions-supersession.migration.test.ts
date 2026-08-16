import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * Phase 3 (Part E / Part K) — verifies
 * supabase/migrations/20260816b_caye_pending_actions_supersession.sql
 * against a real embedded Postgres. This migration only adds one
 * nullable, self-referencing column to the pre-existing
 * caye_pending_actions table (created by
 * 20260712_caye_pending_actions.sql), so the fixture here recreates just
 * enough of that original table to apply both migrations in order —
 * the same read-only, no-production-connection approach as
 * lib/caye-frontdesk-agent-turns.migration.test.ts.
 */
describe('caye_pending_actions supersession migration (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table public.customers (id uuid primary key default gen_random_uuid());
      create table public.operator_allowlist (id bigint primary key);
      create table public.caye_pending_actions (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references public.customers(id) on delete cascade,
        operator_id bigint references public.operator_allowlist(id) on delete cascade,
        tool_name text not null,
        args jsonb not null,
        args_key text not null,
        summary text not null,
        created_in_request_id uuid not null,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        executed_at timestamptz,
        cancelled_at timestamptz,
        result jsonb
      );
    `)
    const migrationSql = readFileSync(
      join(__dirname, '..', 'supabase', 'migrations', '20260816b_caye_pending_actions_supersession.sql'),
      'utf8'
    )
    await db.exec(migrationSql)
  })

  afterAll(async () => {
    await db.close()
  })

  it('applies cleanly and adds a nullable, self-referencing superseded_by column', async () => {
    const res = await db.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_name = 'caye_pending_actions' and column_name = 'superseded_by'`
    )
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].is_nullable).toBe('YES')
  })

  it('lets superseded_by reference another row and sets it null (not cascade-delete) when that row is removed', async () => {
    const { rows: ws } = await db.query<{ id: string }>(`insert into public.customers default values returning id`)
    const base = {
      workspace_id: ws[0].id,
      tool_name: 'send_reply',
      args: '{}',
      args_key: 'k',
      summary: 's',
      created_in_request_id: '00000000-0000-0000-0000-000000000001',
      expires_at: new Date(Date.now() + 60000).toISOString(),
    }
    const { rows: newer } = await db.query<{ id: string }>(
      `insert into public.caye_pending_actions (workspace_id, tool_name, args, args_key, summary, created_in_request_id, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [base.workspace_id, base.tool_name, base.args, 'k2', base.summary, base.created_in_request_id, base.expires_at]
    )
    const { rows: older } = await db.query<{ id: string }>(
      `insert into public.caye_pending_actions (workspace_id, tool_name, args, args_key, summary, created_in_request_id, expires_at, cancelled_at, superseded_by)
       values ($1, $2, $3, $4, $5, $6, $7, now(), $8) returning id`,
      [base.workspace_id, base.tool_name, base.args, 'k1', base.summary, base.created_in_request_id, base.expires_at, newer[0].id]
    )

    await db.query(`delete from public.caye_pending_actions where id = $1`, [newer[0].id])

    const after = await db.query<{ superseded_by: string | null }>(
      `select superseded_by from public.caye_pending_actions where id = $1`,
      [older[0].id]
    )
    expect(after.rows[0]?.superseded_by).toBeNull()
  })
})
