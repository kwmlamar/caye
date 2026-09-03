import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import {
  SEMANTIC_SCOPES,
  assertScopeDerivation,
  canDeriveScope,
  isSemanticScope,
} from './semantic-scope'

const W1 = '11111111-1111-4111-8111-111111111111'
const W2 = '22222222-2222-4222-8222-222222222222'
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONV_EMAIL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EMAIL_MESSAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FOUNDER_OPERATOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const FOUNDER_ARTIFACT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const ENGINEERING_PARENT = '12121212-1212-4121-8121-121212121212'
const ENGINEERING_CHILD = '13131313-1313-4131-8131-131313131313'
const AMBIGUOUS_EVENT = 40

const migration = readFileSync(
  new URL('../supabase/migrations/20260901141500_semantic_scope_foundation.sql', import.meta.url),
  'utf8',
)

async function createDatabase(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(`
    create table public.customers (id uuid primary key);
    create table public.connected_accounts (id uuid primary key, user_id uuid not null);
    create table public.unified_conversations (
      id uuid primary key,
      connected_account_id uuid not null,
      channel_type text not null
    );
    create table public.unified_messages (
      id uuid primary key,
      conversation_id uuid not null,
      sender_type text not null,
      is_internal boolean not null default false
    );
    create table public.caye_operator_messages (
      id uuid primary key,
      workspace_id uuid not null,
      origin text not null default 'whatsapp'
    );
    create table public.workspace_events (
      id bigint primary key,
      workspace_id uuid not null,
      actor_kind text not null,
      origin text not null default 'trigger'
    );
    create table public.business_artifacts (
      id uuid primary key,
      workspace_id uuid not null,
      origin text not null default 'external',
      source_channel text not null,
      unified_message_id uuid,
      operator_message_id uuid
    );
    create table public.business_artifact_observations (
      id uuid primary key,
      workspace_id uuid not null,
      artifact_id uuid not null,
      derived_by text not null
    );
    create table public.business_learning_observations (
      id uuid primary key,
      workspace_id uuid not null,
      source_kind text not null,
      source_id text not null,
      source_channel text,
      unified_message_id uuid,
      operator_message_id uuid,
      source_metadata jsonb not null default '{}'::jsonb,
      semantic_scope text
    );
    create table public.business_fact_candidates (
      id uuid primary key,
      workspace_id uuid not null,
      observation_id uuid
    );
    create table public.business_facts (
      id uuid primary key,
      workspace_id uuid not null,
      source text not null default 'owner-direct',
      authority_kind text not null default 'operator'
    );
    create table public.caye_work_opportunities (
      id uuid primary key,
      workspace_id uuid not null,
      originating_capability text not null
    );
    create table public.caye_work_opportunity_evidence (
      id uuid primary key,
      workspace_id uuid not null,
      opportunity_id uuid not null,
      source_type text not null,
      source_id text
    );
    create table public.engineering_artifacts (
      id uuid primary key,
      workspace_id uuid not null,
      parent_artifact_id uuid
    );

    insert into public.customers(id) values ('${W1}'), ('${W2}');
    insert into public.connected_accounts(id, user_id) values ('${ACCOUNT}', '${W1}');
    insert into public.unified_conversations(id, connected_account_id, channel_type)
      values ('${CONV_EMAIL}', '${ACCOUNT}', 'email');
    insert into public.unified_messages(id, conversation_id, sender_type, is_internal)
      values ('${EMAIL_MESSAGE}', '${CONV_EMAIL}', 'contact', false);
    insert into public.caye_operator_messages(id, workspace_id, origin)
      values ('${FOUNDER_OPERATOR}', '${W1}', 'founder_job_search');
    insert into public.business_artifacts(
      id, workspace_id, origin, source_channel, operator_message_id
    ) values ('${FOUNDER_ARTIFACT}', '${W1}', 'external', 'dashboard', '${FOUNDER_OPERATOR}');
    insert into public.engineering_artifacts(id, workspace_id, parent_artifact_id)
      values
        ('${ENGINEERING_PARENT}', '${W1}', null),
        ('${ENGINEERING_CHILD}', '${W1}', '${ENGINEERING_PARENT}');
    insert into public.workspace_events(id, workspace_id, actor_kind, origin)
      values (${AMBIGUOUS_EVENT}, '${W1}', 'operator', 'dashboard');
  `)
  await db.exec(migration)
  return db
}

async function scalar<T>(db: PGlite, sql: string): Promise<T> {
  const result = await db.query<Record<string, T>>(sql)
  return Object.values(result.rows[0])[0] as T
}

describe('canonical semantic scope policy', () => {
  it('recognizes every valid scope and rejects invalid scopes', () => {
    for (const scope of SEMANTIC_SCOPES) expect(isSemanticScope(scope)).toBe(true)
    expect(isSemanticScope('customer-ish')).toBe(false)
  })

  it('allows monotonic same-scope derivation and only the explicit internal restriction', () => {
    expect(canDeriveScope('customer_business', 'customer_business')).toBe(true)
    expect(canDeriveScope('engineering_task', 'engineering_task')).toBe(true)
    expect(canDeriveScope('founder_admin', 'founder_admin')).toBe(true)
    expect(canDeriveScope('customer_business', 'system_internal')).toBe(true)
  })

  it('forbids excluded and legacy scope widening into customer_business', () => {
    for (const scope of [
      'engineering_task',
      'founder_admin',
      'platform_test',
      'personal_direct_task',
      'system_internal',
      'legacy_unclassified',
    ] as const) {
      expect(canDeriveScope(scope, 'customer_business')).toBe(false)
    }
  })

  it('rejects cross-workspace derivation independently of scope', () => {
    expect(() => assertScopeDerivation({
      parentWorkspaceId: W1,
      childWorkspaceId: W2,
      parentScope: 'engineering_task',
      requestedChildScope: 'engineering_task',
    })).toThrow(/cross workspaces/)
  })
})

describe('semantic provenance migration and deterministic backfill', () => {
  it('persists every valid scope and rejects an invalid scope', async () => {
    const db = await createDatabase()
    try {
      let id = 100
      for (const scope of SEMANTIC_SCOPES) {
        await db.exec(`insert into public.workspace_events(id, workspace_id, actor_kind, origin)
          values (${id}, '${W1}', 'test_actor', 'manual');`)
        await db.exec(`insert into public.semantic_provenance(
          workspace_id, record_table, record_id, semantic_scope,
          origin_surface, origin_actor_type, origin_ref
        ) values ('${W1}', 'workspace_events', '${id}', '${scope}', 'test', 'test_actor', 'test:${id}');`)
        id += 1
      }
      expect(await scalar<number>(db, `select count(*)::int from public.semantic_provenance where record_table='workspace_events' and record_id in ('100','101','102','103','104','105','106','107')`)).toBe(8)

      await db.exec(`insert into public.workspace_events(id, workspace_id, actor_kind, origin)
        values (108, '${W1}', 'test_actor', 'manual');`)
      await expect(db.exec(`insert into public.semantic_provenance(
        workspace_id, record_table, record_id, semantic_scope,
        origin_surface, origin_actor_type, origin_ref
      ) values ('${W1}', 'workspace_events', '108', 'not_a_scope', 'test', 'test_actor', 'test:108');`)).rejects.toThrow()
    } finally {
      await db.close()
    }
  })

  it('keeps actor identity independent from semantic scope, including customer operator business activity', async () => {
    const db = await createDatabase()
    try {
      const id = '14141414-1414-4141-8141-141414141414'
      await db.exec(`insert into public.caye_operator_messages(id, workspace_id, origin)
        values ('${id}', '${W1}', 'whatsapp');`)
      await db.exec(`insert into public.semantic_provenance(
        workspace_id, record_table, record_id, semantic_scope,
        origin_surface, origin_actor_type, origin_ref
      ) values ('${W1}', 'caye_operator_messages', '${id}', 'customer_business', 'whatsapp', 'customer_operator', 'manual:${id}');`)
      const row = await db.query<{ semantic_scope: string; origin_actor_type: string }>(
        `select semantic_scope, origin_actor_type from public.semantic_provenance where record_id='${id}'`,
      )
      expect(row.rows[0]).toEqual({ semantic_scope: 'customer_business', origin_actor_type: 'customer_operator' })
    } finally {
      await db.close()
    }
  })

  it('inherits engineering_task and founder_admin through deterministic parent provenance', async () => {
    const db = await createDatabase()
    try {
      expect(await scalar<string>(db, `select semantic_scope from public.semantic_provenance where record_table='engineering_artifacts' and record_id='${ENGINEERING_CHILD}'`)).toBe('engineering_task')
      expect(await scalar<string>(db, `select semantic_scope from public.semantic_provenance where record_table='business_artifacts' and record_id='${FOUNDER_ARTIFACT}'`)).toBe('founder_admin')
    } finally {
      await db.close()
    }
  })

  it('rejects excluded and legacy widening into customer_business at the database trigger', async () => {
    const db = await createDatabase()
    try {
      const engineeringParent = await scalar<string>(db, `select id::text from public.semantic_provenance where record_table='engineering_artifacts' and record_id='${ENGINEERING_PARENT}'`)
      const newEngineering = '15151515-1515-4151-8151-151515151515'
      await db.exec(`insert into public.engineering_artifacts(id, workspace_id) values ('${newEngineering}', '${W1}');`)
      await expect(db.exec(`insert into public.semantic_provenance(
        workspace_id, record_table, record_id, semantic_scope, origin_surface,
        origin_actor_type, origin_ref, parent_provenance_id
      ) values ('${W1}', 'engineering_artifacts', '${newEngineering}', 'customer_business', 'engineering', 'engineering_capability', 'test:${newEngineering}', '${engineeringParent}');`)).rejects.toThrow(/cannot widen/)

      const legacyParent = await scalar<string>(db, `select id::text from public.semantic_provenance where record_table='workspace_events' and record_id='${AMBIGUOUS_EVENT}'`)
      await db.exec(`insert into public.workspace_events(id, workspace_id, actor_kind, origin) values (41, '${W1}', 'operator', 'dashboard');`)
      await expect(db.exec(`insert into public.semantic_provenance(
        workspace_id, record_table, record_id, semantic_scope, origin_surface,
        origin_actor_type, origin_ref, parent_provenance_id
      ) values ('${W1}', 'workspace_events', '41', 'customer_business', 'dashboard', 'operator', 'test:41', '${legacyParent}');`)).rejects.toThrow(/cannot widen/)
    } finally {
      await db.close()
    }
  })

  it('rejects workspace mismatch and direct privileged-style SQL cannot bypass the trigger', async () => {
    const db = await createDatabase()
    try {
      const parent = await scalar<string>(db, `select id::text from public.semantic_provenance where record_table='engineering_artifacts' and record_id='${ENGINEERING_PARENT}'`)
      const child = '16161616-1616-4161-8161-161616161616'
      await db.exec(`insert into public.engineering_artifacts(id, workspace_id) values ('${child}', '${W2}');`)
      await expect(db.exec(`insert into public.semantic_provenance(
        workspace_id, record_table, record_id, semantic_scope, origin_surface,
        origin_actor_type, origin_ref, parent_provenance_id
      ) values ('${W2}', 'engineering_artifacts', '${child}', 'engineering_task', 'engineering', 'engineering_capability', 'test:${child}', '${parent}');`)).rejects.toThrow(/cross workspaces/)

      const wrongWorkspaceEvent = 50
      await db.exec(`insert into public.workspace_events(id, workspace_id, actor_kind, origin) values (${wrongWorkspaceEvent}, '${W1}', 'system', 'system');`)
      await expect(db.exec(`insert into public.semantic_provenance(
        workspace_id, record_table, record_id, semantic_scope, origin_surface,
        origin_actor_type, origin_ref
      ) values ('${W2}', 'workspace_events', '${wrongWorkspaceEvent}', 'system_internal', 'system', 'system', 'test:${wrongWorkspaceEvent}');`)).rejects.toThrow(/workspace mismatch/)
    } finally {
      await db.close()
    }
  })

  it('backfills deterministic customer, engineering, founder/admin, and ambiguous legacy scopes', async () => {
    const db = await createDatabase()
    try {
      expect(await scalar<string>(db, `select semantic_scope from public.semantic_provenance where record_table='unified_messages' and record_id='${EMAIL_MESSAGE}'`)).toBe('customer_business')
      expect(await scalar<string>(db, `select semantic_scope from public.semantic_provenance where record_table='engineering_artifacts' and record_id='${ENGINEERING_PARENT}'`)).toBe('engineering_task')
      expect(await scalar<string>(db, `select semantic_scope from public.semantic_provenance where record_table='caye_operator_messages' and record_id='${FOUNDER_OPERATOR}'`)).toBe('founder_admin')
      expect(await scalar<string>(db, `select semantic_scope from public.semantic_provenance where record_table='workspace_events' and record_id='${AMBIGUOUS_EVENT}'`)).toBe('legacy_unclassified')
    } finally {
      await db.close()
    }
  })

  it('is idempotent on a second backfill run', async () => {
    const db = await createDatabase()
    try {
      const before = await scalar<number>(db, 'select count(*)::int from public.semantic_provenance')
      await db.exec('select * from public.backfill_semantic_provenance(false);')
      const after = await scalar<number>(db, 'select count(*)::int from public.semantic_provenance')
      expect(after).toBe(before)
    } finally {
      await db.close()
    }
  })

  it('dry-run reports candidates but mutates nothing', async () => {
    const db = await createDatabase()
    try {
      const id = '17171717-1717-4171-8171-171717171717'
      await db.exec(`insert into public.engineering_artifacts(id, workspace_id) values ('${id}', '${W1}');`)
      const before = await scalar<number>(db, 'select count(*)::int from public.semantic_provenance')
      await db.exec('select * from public.backfill_semantic_provenance(true);')
      const after = await scalar<number>(db, 'select count(*)::int from public.semantic_provenance')
      expect(after).toBe(before)
      expect(await scalar<number>(db, `select count(*)::int from public.semantic_provenance where record_id='${id}'`)).toBe(0)
    } finally {
      await db.close()
    }
  })

  it('migration and backfill are safe to rerun', async () => {
    const db = await createDatabase()
    try {
      const before = await scalar<number>(db, 'select count(*)::int from public.semantic_provenance')
      await db.exec(migration)
      const after = await scalar<number>(db, 'select count(*)::int from public.semantic_provenance')
      expect(after).toBe(before)
    } finally {
      await db.close()
    }
  })
})
