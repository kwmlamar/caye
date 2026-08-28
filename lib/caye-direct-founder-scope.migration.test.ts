import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

describe('founder-scoped Caye Direct migration (PGlite)', () => {
  let db: PGlite
  let legacyWorkspaceId: string
  let legacyThreadId: string
  let legacyMessageId: string

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table public.customers (
        id uuid primary key default gen_random_uuid(),
        business_name text
      );
      create table public.caye_direct_threads (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references public.customers(id),
        title text,
        status text not null default 'active',
        summary text,
        summary_updated_at timestamptz,
        created_by text not null default 'founder',
        last_activity_at timestamptz not null default now(),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        pinned_at timestamptz
      );
      create table public.caye_operator_messages (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references public.customers(id),
        direction text not null,
        origin text,
        operator_role text,
        body text,
        claude_format jsonb
      );
      do $$
      begin
        if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      end
      $$;
    `)

    const ws = await db.query<{ id: string }>("insert into customers (business_name) values ('Legacy Workspace') returning id")
    legacyWorkspaceId = ws.rows[0].id
    const oldThread = await db.query<{ id: string }>(
      `insert into caye_direct_threads (workspace_id, summary) values ($1, 'legacy summary') returning id`,
      [legacyWorkspaceId]
    )
    legacyThreadId = oldThread.rows[0].id
    const oldMessage = await db.query<{ id: string }>(
      `insert into caye_operator_messages (workspace_id, direction, origin, operator_role, body, claude_format)
       values ($1, 'inbound', 'dashboard', 'founder', 'legacy question', '{"role":"user","content":"legacy question"}'::jsonb)
       returning id`,
      [legacyWorkspaceId]
    )
    legacyMessageId = oldMessage.rows[0].id

    const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20260828_founder_global_direct.sql'), 'utf8')
    await db.exec(sql)
  })

  afterAll(async () => { await db.close() })

  it('backfills legacy threads without changing their home workspace', async () => {
    const row = await db.query<{ workspace_id: string; active_workspace_id: string; scope_kind: string; has_cross_workspace_context: boolean }>(
      `select workspace_id, active_workspace_id, scope_kind, has_cross_workspace_context
       from caye_direct_threads where id=$1`, [legacyThreadId]
    )
    expect(row.rows[0]).toEqual({
      workspace_id: legacyWorkspaceId,
      active_workspace_id: legacyWorkspaceId,
      scope_kind: 'founder',
      has_cross_workspace_context: false,
    })
  })

  it('backfills a workspace boundary marker into legacy founder Direct model history', async () => {
    const row = await db.query<{ body: string; claude_format: { content: string } }>(
      `select body, claude_format from caye_operator_messages where id=$1`, [legacyMessageId]
    )
    expect(row.rows[0].body).toBe('legacy question')
    expect(row.rows[0].claude_format.content).toBe('[Founder Direct workspace: Legacy Workspace]\n\nlegacy question')
  })

  it('marks a thread cross-workspace and suppresses unscoped summaries after a context move', async () => {
    const other = await db.query<{ id: string }>("insert into customers (business_name) values ('Other') returning id")
    const moved = await db.query<{ workspace_id: string; active_workspace_id: string; has_cross_workspace_context: boolean; summary: string | null }>(
      `update caye_direct_threads set active_workspace_id=$2, summary='must disappear' where id=$1
       returning workspace_id, active_workspace_id, has_cross_workspace_context, summary`,
      [legacyThreadId, other.rows[0].id]
    )
    expect(moved.rows[0].workspace_id).toBe(legacyWorkspaceId)
    expect(moved.rows[0].active_workspace_id).toBe(other.rows[0].id)
    expect(moved.rows[0].has_cross_workspace_context).toBe(true)
    expect(moved.rows[0].summary).toBeNull()
  })

  it('scopes new founder Direct inbound model history while leaving visible body unchanged', async () => {
    const ws = await db.query<{ id: string }>("insert into customers (business_name) values ('TropiTech Solutions') returning id")
    const inserted = await db.query<{ body: string; claude_format: { content: string } }>(
      `insert into caye_operator_messages (workspace_id, direction, origin, operator_role, body, claude_format)
       values ($1, 'inbound', 'dashboard', 'founder', 'How is the property?', '{"role":"user","content":"How is the property?"}'::jsonb)
       returning body, claude_format`, [ws.rows[0].id]
    )
    expect(inserted.rows[0].body).toBe('How is the property?')
    expect(inserted.rows[0].claude_format.content).toBe('[Founder Direct workspace: TropiTech Solutions]\n\nHow is the property?')
  })
})
