import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('domain integration corrective migration', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table public.customers (
        id uuid primary key default gen_random_uuid()
      );
      create table public.business_artifacts (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references public.customers(id) on delete cascade
      );
      create table public.workspace_events (
        id bigint generated always as identity primary key,
        workspace_id uuid not null,
        occurred_at timestamptz not null,
        type text not null,
        actor_kind text not null,
        is_failure boolean not null default false,
        conversation_id uuid,
        subject_table text,
        subject_id text,
        payload jsonb not null default '{}'::jsonb,
        origin text
      );
      do $$ begin
        if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
        if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
        if not exists(select from pg_roles where rolname='service_role') then create role service_role; end if;
      end $$;
    `)

    const dir = join(__dirname, '..', '..', 'supabase', 'migrations')
    for (const file of [
      '20260901190000_business_entity_kernel.sql',
      '20260901_domain_event_projection_bridge.sql',
      '20260902000000_domain_change_source_snapshots.sql',
      '20260902043000_domain_integration_review_fixes.sql',
    ]) {
      await db.exec(readFileSync(join(dir, file), 'utf8'))
    }
  })

  afterAll(async () => db.close())

  async function workspace() {
    return (await db.query<{ id: string }>(
      'insert into customers default values returning id',
    )).rows[0].id
  }

  async function entity(workspaceId: string, nativeKey: string) {
    return (await db.query<{ id: string }>(
      `insert into business_entities
         (workspace_id, domain, entity_type, authority, native_key)
       values ($1, 'x', 'purchase_order', 'caye_authoritative', $2)
       returning id`,
      [workspaceId, nativeKey],
    )).rows[0].id
  }

  async function ingest(input: {
    workspaceId: string
    sourceEntityId: string
    cayeEntityId: string | null
    idempotencyKey: string
  }) {
    return db.query<{ result: { status: string } }>(
      `select public.ingest_external_domain_event(
         $1::uuid,
         'bedrock',
         'company-a',
         'purchase_order',
         $2,
         $3::uuid,
         'domain.purchase_order.status_changed',
         '2026-08-20T12:00:00Z'::timestamptz,
         '2026-09-02T04:00:00Z'::timestamptz,
         $4,
         'v1',
         'outside',
         '{}'::jsonb
       ) as result`,
      [input.workspaceId, input.sourceEntityId, input.cayeEntityId, input.idempotencyKey],
    )
  }

  it('rejects cross-workspace artifact provenance and accepts same-workspace provenance', async () => {
    const a = await workspace()
    const b = await workspace()
    const entities = (await db.query<{ id: string }>(
      `insert into business_entities
         (workspace_id, domain, entity_type, authority, native_key)
       values
         ($1, 'x', 'a', 'caye_authoritative', 'a'),
         ($1, 'x', 'b', 'caye_authoritative', 'b')
       returning id`,
      [a],
    )).rows
    const artA = (await db.query<{ id: string }>(
      'insert into business_artifacts(workspace_id) values($1) returning id',
      [a],
    )).rows[0].id
    const artB = (await db.query<{ id: string }>(
      'insert into business_artifacts(workspace_id) values($1) returning id',
      [b],
    )).rows[0].id

    await expect(db.query(
      `insert into business_entity_relations
         (workspace_id, subject_entity_id, object_entity_id, relation_type, asserted_by, source_artifact_id)
       values ($1, $2, $3, 'rel', 'operator', $4)`,
      [a, entities[0].id, entities[1].id, artB],
    )).rejects.toThrow()

    await expect(db.query(
      `insert into business_entity_relations
         (workspace_id, subject_entity_id, object_entity_id, relation_type, asserted_by, source_artifact_id)
       values ($1, $2, $3, 'rel', 'operator', $4)`,
      [a, entities[0].id, entities[1].id, artA],
    )).resolves.toBeTruthy()
  })

  it('ingests both resolved UUID and unresolved domain events after all integration migrations', async () => {
    const a = await workspace()
    const resolvedEntity = await entity(a, 'resolved-po')

    const resolved = await ingest({
      workspaceId: a,
      sourceEntityId: 'po-resolved',
      cayeEntityId: resolvedEntity,
      idempotencyKey: 'resolved-event',
    })
    expect(resolved.rows[0].result.status).toBe('inserted')

    const unresolved = await ingest({
      workspaceId: a,
      sourceEntityId: 'po-unresolved',
      cayeEntityId: null,
      idempotencyKey: 'unresolved-event',
    })
    expect(unresolved.rows[0].result.status).toBe('inserted')

    const state = await db.query<{ source_entity_id: string; caye_entity_id: string | null }>(
      `select source_entity_id, caye_entity_id
         from domain_entity_observation_state
        where workspace_id = $1
        order by source_entity_id`,
      [a],
    )
    expect(state.rows).toEqual([
      { source_entity_id: 'po-resolved', caye_entity_id: resolvedEntity },
      { source_entity_id: 'po-unresolved', caye_entity_id: null },
    ])
  })

  it('rejects a resolved entity from another workspace through the ingestion RPC', async () => {
    const a = await workspace()
    const b = await workspace()
    const foreignEntity = await entity(b, 'foreign-po')

    await expect(ingest({
      workspaceId: a,
      sourceEntityId: 'po-cross-workspace',
      cayeEntityId: foreignEntity,
      idempotencyKey: 'cross-workspace-event',
    })).rejects.toThrow()

    const events = await db.query(
      `select id from workspace_events
        where workspace_id = $1
          and subject_id = 'bedrock:purchase_order:po-cross-workspace'`,
      [a],
    )
    expect(events.rows).toHaveLength(0)
  })

  it('rejects nonexistent workspaces and direct cross-workspace observation entities while allowing null identity', async () => {
    const a = await workspace()
    const b = await workspace()
    const foreignEntity = await entity(b, 'direct-foreign')
    const missing = '00000000-0000-0000-0000-000000000099'

    await expect(db.query(
      `insert into domain_sync_cursors(workspace_id, source_system, source_company_id, stream)
       values($1, 'bedrock', 'c', 'po')`,
      [missing],
    )).rejects.toThrow()

    await expect(db.query(
      `insert into domain_entity_observation_state
         (workspace_id, source_system, source_company_id, source_entity_type, source_entity_id,
          caye_entity_id, last_occurred_at, last_observed_at, last_idempotency_key)
       values($1, 'bedrock', 'c', 'purchase_order', '1', $2, now(), now(), 'k')`,
      [a, foreignEntity],
    )).rejects.toThrow()

    await expect(db.query(
      `insert into domain_entity_observation_state
         (workspace_id, source_system, source_company_id, source_entity_type, source_entity_id,
          caye_entity_id, last_occurred_at, last_observed_at, last_idempotency_key)
       values($1, 'bedrock', 'c', 'purchase_order', '2', null, now(), now(), 'k2')`,
      [a],
    )).resolves.toBeTruthy()
  })

  it('cascades bridge state when a workspace is deleted', async () => {
    const a = await workspace()
    await db.query(
      `insert into domain_sync_cursors(workspace_id, source_system, source_company_id, stream)
       values($1, 'bedrock', 'c', 'po')`,
      [a],
    )
    await db.query('delete from customers where id=$1', [a])
    expect((await db.query(
      'select * from domain_sync_cursors where workspace_id=$1',
      [a],
    )).rows).toHaveLength(0)
  })
})
