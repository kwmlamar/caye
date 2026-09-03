import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

const W1 = '11111111-1111-4111-8111-111111111111'
const PARENT = '12121212-1212-4121-8121-121212121212'
const CHILD = '13131313-1313-4131-8131-131313131313'

const foundationMigration = readFileSync(
  new URL('../supabase/migrations/20260901141500_semantic_scope_foundation.sql', import.meta.url),
  'utf8',
)
const parentBindingMigration = readFileSync(
  new URL('../supabase/migrations/20260901142500_semantic_scope_parent_binding.sql', import.meta.url),
  'utf8',
)

async function createDatabase(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(`
    create table public.customers (id uuid primary key);
    create table public.connected_accounts (id uuid primary key, user_id uuid not null);
    create table public.unified_conversations (id uuid primary key, connected_account_id uuid not null, channel_type text not null);
    create table public.unified_messages (id uuid primary key, conversation_id uuid not null, sender_type text not null, is_internal boolean not null default false);
    create table public.caye_operator_messages (id uuid primary key, workspace_id uuid not null, origin text not null default 'whatsapp');
    create table public.workspace_events (id bigint primary key, workspace_id uuid not null, actor_kind text not null, origin text not null default 'trigger');
    create table public.business_artifacts (id uuid primary key, workspace_id uuid not null, origin text not null default 'external', source_channel text not null, unified_message_id uuid, operator_message_id uuid);
    create table public.business_artifact_observations (id uuid primary key, workspace_id uuid not null, artifact_id uuid not null, derived_by text not null);
    create table public.business_learning_observations (id uuid primary key, workspace_id uuid not null, source_kind text not null, source_id text not null, source_channel text, unified_message_id uuid, operator_message_id uuid, source_metadata jsonb not null default '{}'::jsonb, semantic_scope text);
    create table public.business_fact_candidates (id uuid primary key, workspace_id uuid not null, observation_id uuid);
    create table public.business_facts (id uuid primary key, workspace_id uuid not null, source text not null default 'owner-direct', authority_kind text not null default 'operator');
    create table public.caye_work_opportunities (id uuid primary key, workspace_id uuid not null, originating_capability text not null);
    create table public.caye_work_opportunity_evidence (id uuid primary key, workspace_id uuid not null, opportunity_id uuid not null, source_type text not null, source_id text);
    create table public.engineering_artifacts (id uuid primary key, workspace_id uuid not null, parent_artifact_id uuid);

    insert into public.customers(id) values ('${W1}');
    insert into public.engineering_artifacts(id, workspace_id, parent_artifact_id)
      values ('${PARENT}', '${W1}', null), ('${CHILD}', '${W1}', '${PARENT}');
  `)
  await db.exec(foundationMigration)
  await db.exec(parentBindingMigration)
  return db
}

describe('semantic provenance parent binding', () => {
  it('prevents a privileged write from omitting a deterministic parent', async () => {
    const db = await createDatabase()
    try {
      await expect(db.exec(`
        update public.semantic_provenance
        set parent_provenance_id = null
        where record_table = 'engineering_artifacts' and record_id = '${CHILD}';
      `)).rejects.toThrow(/requires parent/)
    } finally {
      await db.close()
    }
  })

  it('rejects binding a derived record to the wrong persisted parent', async () => {
    const db = await createDatabase()
    try {
      const otherParent = '14141414-1414-4141-8141-141414141414'
      await db.exec(`insert into public.engineering_artifacts(id, workspace_id) values ('${otherParent}', '${W1}');`)
      await db.exec(`insert into public.semantic_provenance(
        workspace_id, record_table, record_id, semantic_scope,
        origin_surface, origin_actor_type, origin_ref
      ) values ('${W1}', 'engineering_artifacts', '${otherParent}', 'engineering_task', 'engineering', 'engineering_capability', 'test:${otherParent}');`)
      const wrongParent = await db.query<{ id: string }>(`select id::text as id from public.semantic_provenance where record_table='engineering_artifacts' and record_id='${otherParent}'`)
      await expect(db.exec(`
        update public.semantic_provenance
        set parent_provenance_id = '${wrongParent.rows[0].id}'
        where record_table = 'engineering_artifacts' and record_id = '${CHILD}';
      `)).rejects.toThrow(/parent mismatch/)
    } finally {
      await db.close()
    }
  })
})
