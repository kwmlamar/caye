import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

describe('conversation execution coordination migration (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table public.customers (id uuid primary key default gen_random_uuid());
      create table public.unified_conversations (id uuid primary key default gen_random_uuid());
      create table public.unified_messages (
        id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.unified_conversations(id),
        sender_type text not null default 'customer', is_internal boolean not null default false, sent_at timestamptz not null default now()
      );
      create table public.caye_pending_actions (
        id uuid primary key default gen_random_uuid(), execution_claim_id uuid, executed_at timestamptz, cancelled_at timestamptz, expires_at timestamptz not null default now()
      );
      create role anon; create role authenticated; create role service_role;
    `)
    const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20260825_conversation_execution_coordination.sql'), 'utf8')
    await db.exec(sql)
  })

  afterAll(async () => { await db.close() })

  it('permits one active owner but preserves the completed audit history', async () => {
    const { rows: ws } = await db.query<{ id: string }>('insert into public.customers default values returning id')
    const { rows: conv } = await db.query<{ id: string }>('insert into public.unified_conversations default values returning id')
    const insert = `insert into public.conversation_execution_claims (workspace_id, conversation_id, holder_kind, idempotency_key, expires_at) values ($1, $2, 'autonomous_frontdesk', $3, now() + interval '15 minutes') returning id`
    const first = await db.query<{ id: string }>(insert, [ws[0].id, conv[0].id, 'inbound-a'])
    await expect(db.query(insert, [ws[0].id, conv[0].id, 'inbound-b'])).rejects.toMatchObject({ code: '23505' })
    await db.query('update public.conversation_execution_claims set completed_at = now() where id = $1', [first.rows[0].id])
    await expect(db.query(insert, [ws[0].id, conv[0].id, 'inbound-b'])).resolves.toBeDefined()
  })

  it('enforces one response execution per inbound customer turn', async () => {
    const { rows: ws } = await db.query<{ id: string }>('insert into public.customers default values returning id')
    const { rows: conv } = await db.query<{ id: string }>('insert into public.unified_conversations default values returning id')
    const { rows: msg } = await db.query<{ id: string }>('insert into public.unified_messages (conversation_id) values ($1) returning id', [conv[0].id])
    const { rows: claim } = await db.query<{ id: string }>(`insert into public.conversation_execution_claims (workspace_id, conversation_id, holder_kind, idempotency_key, expires_at) values ($1, $2, 'autonomous_frontdesk', 'same-turn', now() + interval '15 minutes') returning id`, [ws[0].id, conv[0].id])
    const insert = `insert into public.conversation_response_executions (workspace_id, conversation_id, inbound_message_id, claim_id, disposition) values ($1, $2, $3, $4, 'reply')`
    await db.query(insert, [ws[0].id, conv[0].id, msg[0].id, claim[0].id])
    await expect(db.query(insert, [ws[0].id, conv[0].id, msg[0].id, claim[0].id])).rejects.toMatchObject({ code: '23505' })
  })
})
