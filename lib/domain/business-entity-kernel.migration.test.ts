import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * Executes the kernel migration against a real Postgres and exercises the
 * invariants that must hold at the database layer, not merely in TypeScript.
 */
describe('business entity kernel migration (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table public.customers (id uuid primary key default gen_random_uuid());
      create table public.business_artifacts (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references public.customers(id) on delete cascade
      );
      do $$
      begin
        if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end
      $$;
    `)
    const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations')
    await db.exec(readFileSync(join(migrationsDir, '20260901190000_business_entity_kernel.sql'), 'utf8'))
  })

  afterAll(async () => {
    await db.close()
  })

  async function workspace(): Promise<string> {
    const { rows } = await db.query<{ id: string }>('insert into public.customers default values returning id')
    return rows[0].id
  }

  type EntityRow = {
    id: string
    workspace_id: string
    domain: string
    entity_type: string
    display_name: string | null
    authority: string
    source_system: string | null
    source_entity_type: string | null
    source_entity_id: string | null
    native_key: string | null
    status: string
  }

  async function resolve(args: {
    workspaceId: string
    domain: string
    entityType: string
    authority: string
    sourceSystem?: string | null
    sourceEntityType?: string | null
    sourceEntityId?: string | null
    displayName?: string | null
    nativeKey?: string | null
  }) {
    const { rows } = await db.query<EntityRow>(
      `select * from public.resolve_business_entity($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        args.workspaceId,
        args.domain,
        args.entityType,
        args.authority,
        args.sourceSystem ?? null,
        args.sourceEntityType ?? null,
        args.sourceEntityId ?? null,
        args.displayName ?? null,
        args.nativeKey ?? null,
      ]
    )
    return rows[0]
  }

  async function bedrockProject(workspaceId: string, sourceEntityId: string, displayName?: string) {
    return resolve({
      workspaceId,
      domain: 'construction',
      entityType: 'project',
      authority: 'external_authoritative',
      sourceSystem: 'bedrock',
      sourceEntityType: 'project',
      sourceEntityId,
      displayName: displayName ?? null,
    })
  }

  it('applies cleanly and leaves every kernel table deny-by-default', async () => {
    const names = ['business_entities', 'business_entity_relations', 'domain_source_connections']
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname = any($1::text[]) order by relname`,
      [names]
    )
    expect(rows.map((row) => row.relname)).toEqual([...names].sort())
    expect(rows.every((row) => row.relrowsecurity)).toBe(true)

    const { rows: policies } = await db.query<{ count: string }>(
      `select count(*)::text as count from pg_policies where tablename = any($1::text[])`,
      [names]
    )
    expect(policies[0].count).toBe('0')
  })

  it('holds no place to mirror external operational state', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'business_entities'`
    )
    const columns = rows.map((row) => row.column_name)
    expect(columns).not.toContain('state')
    expect(columns).not.toContain('metadata')
    expect(columns).not.toContain('external_record')
    expect(columns.filter((name) => name.endsWith('_json'))).toEqual([])
  })

  it('registers an externally authoritative entity with normalized identity', async () => {
    const workspaceId = await workspace()
    const entity = await resolve({
      workspaceId,
      domain: 'Construction',
      entityType: 'Project',
      authority: 'external_authoritative',
      sourceSystem: 'Bedrock',
      sourceEntityType: 'Project',
      sourceEntityId: '  abc-123  ',
      displayName: 'Off the Reef',
    })

    expect(entity.authority).toBe('external_authoritative')
    expect(entity.domain).toBe('construction')
    expect(entity.entity_type).toBe('project')
    expect(entity.source_system).toBe('bedrock')
    expect(entity.source_entity_type).toBe('project')
    // Trimmed, but case preserved: external ids are frequently case-sensitive.
    expect(entity.source_entity_id).toBe('abc-123')
    expect(entity.display_name).toBe('Off the Reef')
    expect(entity.status).toBe('active')
  })

  it('returns the same canonical id for repeated resolution of one external identity', async () => {
    const workspaceId = await workspace()
    const first = await bedrockProject(workspaceId, 'repeat-1', 'Off the Reef')
    const second = await bedrockProject(workspaceId, 'repeat-1')
    const third = await bedrockProject(workspaceId, 'repeat-1', 'Off the Reef')

    expect(second.id).toBe(first.id)
    expect(third.id).toBe(first.id)

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.business_entities where workspace_id = $1`,
      [workspaceId]
    )
    expect(rows[0].count).toBe('1')
  })

  it('never blanks a display name when a later resolver omits one', async () => {
    const workspaceId = await workspace()
    await bedrockProject(workspaceId, 'named-1', 'Off the Reef')
    const withoutName = await bedrockProject(workspaceId, 'named-1')
    expect(withoutName.display_name).toBe('Off the Reef')

    const renamed = await bedrockProject(workspaceId, 'named-1', 'Off the Reef - Phase 2')
    expect(renamed.display_name).toBe('Off the Reef - Phase 2')
  })

  it('lets the unique index arbitrate concurrent registration of one identity', async () => {
    const workspaceId = await workspace()
    const results = await Promise.all(
      Array.from({ length: 12 }, () => bedrockProject(workspaceId, 'concurrent-1', 'Off the Reef'))
    )
    const ids = new Set(results.map((row) => row.id))
    expect(ids.size).toBe(1)

    // The constraint, not the application, is what makes that true.
    const first = results[0]
    await expect(
      db.query(
        `insert into public.business_entities
           (workspace_id, domain, entity_type, authority, source_system, source_entity_type, source_entity_id)
         values ($1, 'construction', 'project', 'external_authoritative', 'bedrock', 'project', 'concurrent-1')`,
        [workspaceId]
      )
    ).rejects.toThrow()
    expect(first.source_entity_id).toBe('concurrent-1')
  })

  it('keeps the same external id independent across workspaces', async () => {
    const workspaceA = await workspace()
    const workspaceB = await workspace()
    const a = await bedrockProject(workspaceA, 'shared-id')
    const b = await bedrockProject(workspaceB, 'shared-id')

    expect(a.id).not.toBe(b.id)
    expect(a.workspace_id).toBe(workspaceA)
    expect(b.workspace_id).toBe(workspaceB)
  })

  it('keeps the same external id independent across source systems', async () => {
    const workspaceId = await workspace()
    const bedrock = await bedrockProject(workspaceId, 'cross-system')
    const other = await resolve({
      workspaceId,
      domain: 'construction',
      entityType: 'project',
      authority: 'external_authoritative',
      sourceSystem: 'another-system',
      sourceEntityType: 'project',
      sourceEntityId: 'cross-system',
    })

    expect(other.id).not.toBe(bedrock.id)
  })

  it('rejects a partial external source identity', async () => {
    const workspaceId = await workspace()

    await expect(
      resolve({
        workspaceId,
        domain: 'construction',
        entityType: 'project',
        authority: 'external_authoritative',
        sourceSystem: 'bedrock',
        sourceEntityType: null,
        sourceEntityId: 'abc',
      })
    ).rejects.toThrow(/partial external source identity/i)

    // And directly at the table, bypassing the function entirely.
    await expect(
      db.query(
        `insert into public.business_entities
           (workspace_id, domain, entity_type, authority, source_system, source_entity_id)
         values ($1, 'construction', 'project', 'evidence_only', 'bedrock', 'abc')`,
        [workspaceId]
      )
    ).rejects.toThrow()
  })

  it('rejects external_authoritative without a source identity', async () => {
    const workspaceId = await workspace()

    await expect(
      resolve({
        workspaceId,
        domain: 'construction',
        entityType: 'project',
        authority: 'external_authoritative',
      })
    ).rejects.toThrow(/requires a complete external source identity/i)

    await expect(
      db.query(
        `insert into public.business_entities (workspace_id, domain, entity_type, authority)
         values ($1, 'construction', 'project', 'external_authoritative')`,
        [workspaceId]
      )
    ).rejects.toThrow()
  })

  it('rejects caye_authoritative carrying an external source identity', async () => {
    const workspaceId = await workspace()

    await expect(
      resolve({
        workspaceId,
        domain: 'operations',
        entityType: 'commitment',
        authority: 'caye_authoritative',
        sourceSystem: 'bedrock',
        sourceEntityType: 'project',
        sourceEntityId: 'abc',
      })
    ).rejects.toThrow(/must not carry external source identity/i)

    await expect(
      db.query(
        `insert into public.business_entities
           (workspace_id, domain, entity_type, authority, source_system, source_entity_type, source_entity_id)
         values ($1, 'operations', 'commitment', 'caye_authoritative', 'bedrock', 'project', 'abc')`,
        [workspaceId]
      )
    ).rejects.toThrow()
  })

  it('rejects an unsupported authority class', async () => {
    const workspaceId = await workspace()
    await expect(
      resolve({ workspaceId, domain: 'construction', entityType: 'project', authority: 'source_of_truth' })
    ).rejects.toThrow(/unsupported business entity authority/i)
  })

  it('refuses to re-register an existing identity under a different authority', async () => {
    const workspaceId = await workspace()
    await bedrockProject(workspaceId, 'authority-lock')

    await expect(
      resolve({
        workspaceId,
        domain: 'construction',
        entityType: 'project',
        authority: 'evidence_only',
        sourceSystem: 'bedrock',
        sourceEntityType: 'project',
        sourceEntityId: 'authority-lock',
      })
    ).rejects.toThrow(/refusing to re-register/i)
  })

  it('registers and re-resolves a Caye-authoritative entity by its native key', async () => {
    const workspaceId = await workspace()
    const first = await resolve({
      workspaceId,
      domain: 'operations',
      entityType: 'commitment',
      authority: 'caye_authoritative',
      nativeKey: 'procurement-followthrough',
      displayName: 'Open procurement commitment',
    })
    const second = await resolve({
      workspaceId,
      domain: 'operations',
      entityType: 'commitment',
      authority: 'caye_authoritative',
      nativeKey: 'procurement-followthrough',
    })

    expect(first.authority).toBe('caye_authoritative')
    expect(first.source_system).toBeNull()
    expect(first.native_key).toBe('procurement-followthrough')
    expect(second.id).toBe(first.id)
  })

  it('refuses a native key on anything that is not Caye-authoritative', async () => {
    const workspaceId = await workspace()
    await expect(
      resolve({
        workspaceId,
        domain: 'construction',
        entityType: 'project',
        authority: 'evidence_only',
        nativeKey: 'not-allowed',
      })
    ).rejects.toThrow(/native_key is only valid/i)
  })

  it('mints a new identity when a Caye-native registration offers no deterministic key', async () => {
    const workspaceId = await workspace()
    const first = await resolve({
      workspaceId,
      domain: 'operations',
      entityType: 'commitment',
      authority: 'caye_authoritative',
      displayName: 'One-off commitment',
    })
    const second = await resolve({
      workspaceId,
      domain: 'operations',
      entityType: 'commitment',
      authority: 'caye_authoritative',
      displayName: 'One-off commitment',
    })
    expect(second.id).not.toBe(first.id)
  })

  it('creates a same-workspace relation and keeps re-assertion idempotent', async () => {
    const workspaceId = await workspace()
    const project = await bedrockProject(workspaceId, 'rel-project', 'Off the Reef')
    const purchaseOrder = await resolve({
      workspaceId,
      domain: 'construction',
      entityType: 'purchase_order',
      authority: 'external_authoritative',
      sourceSystem: 'bedrock',
      sourceEntityType: 'purchase_order',
      sourceEntityId: 'PO-123',
    })

    const assert = () =>
      db.query<{ id: string; relation_type: string; last_asserted_at: string; provenance: unknown }>(
        `select * from public.upsert_business_entity_relation($1, $2, $3, 'belongs_to', 'domain_adapter', 'bedrock', null, $4::jsonb, null, now())`,
        [workspaceId, purchaseOrder.id, project.id, JSON.stringify({ observed_via: 'purchase_order.project_id' })]
      )

    const first = (await assert()).rows[0]
    for (let i = 0; i < 19; i += 1) await assert()

    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.business_entity_relations
        where workspace_id = $1 and status = 'active'`,
      [workspaceId]
    )
    expect(rows[0].count).toBe('1')
    expect(first.relation_type).toBe('belongs_to')

    // The database, not the application, is what collapses those twenty polls.
    await expect(
      db.query(
        `insert into public.business_entity_relations
           (workspace_id, subject_entity_id, object_entity_id, relation_type, asserted_by, source_system)
         values ($1, $2, $3, 'belongs_to', 'domain_adapter', 'bedrock')`,
        [workspaceId, purchaseOrder.id, project.id]
      )
    ).rejects.toThrow()
  })

  it('rejects a cross-workspace relation at the database layer', async () => {
    const workspaceA = await workspace()
    const workspaceB = await workspace()
    const projectA = await bedrockProject(workspaceA, 'x-ws-a')
    const projectB = await bedrockProject(workspaceB, 'x-ws-b')
    const clientA = await resolve({
      workspaceId: workspaceA,
      domain: 'construction',
      entityType: 'client',
      authority: 'external_authoritative',
      sourceSystem: 'bedrock',
      sourceEntityType: 'client',
      sourceEntityId: 'client-a',
    })

    await expect(
      db.query(
        `select * from public.upsert_business_entity_relation($1, $2, $3, 'belongs_to', 'domain_adapter', 'bedrock')`,
        [workspaceA, projectA.id, projectB.id]
      )
    ).rejects.toThrow(/not in workspace/i)

    // Direct SQL cannot get around it either: the composite foreign key means
    // the object row does not exist under workspace A at all.
    await expect(
      db.query(
        `insert into public.business_entity_relations
           (workspace_id, subject_entity_id, object_entity_id, relation_type, asserted_by, source_system)
         values ($1, $2, $3, 'belongs_to', 'domain_adapter', 'bedrock')`,
        [workspaceA, projectA.id, projectB.id]
      )
    ).rejects.toThrow()

    // And a relation cannot claim a workspace that is not its entities'.
    await expect(
      db.query(
        `insert into public.business_entity_relations
           (workspace_id, subject_entity_id, object_entity_id, relation_type, asserted_by, source_system)
         values ($1, $2, $3, 'belongs_to', 'domain_adapter', 'bedrock')`,
        [workspaceB, projectA.id, clientA.id]
      )
    ).rejects.toThrow()
  })

  it('rejects empty relation types and self edges', async () => {
    const workspaceId = await workspace()
    const project = await bedrockProject(workspaceId, 'guard-project')
    const client = await resolve({
      workspaceId,
      domain: 'construction',
      entityType: 'client',
      authority: 'external_authoritative',
      sourceSystem: 'bedrock',
      sourceEntityType: 'client',
      sourceEntityId: 'guard-client',
    })

    await expect(
      db.query(`select * from public.upsert_business_entity_relation($1, $2, $3, '   ', 'operator')`, [
        workspaceId,
        project.id,
        client.id,
      ])
    ).rejects.toThrow(/requires a relation type/i)

    await expect(
      db.query(
        `select * from public.upsert_business_entity_relation($1, $2, $2, 'belongs_to', 'operator')`,
        [workspaceId, project.id]
      )
    ).rejects.toThrow()
  })

  it('requires an adapter-asserted relation to name its source system', async () => {
    const workspaceId = await workspace()
    const project = await bedrockProject(workspaceId, 'src-project')
    const client = await resolve({
      workspaceId,
      domain: 'construction',
      entityType: 'client',
      authority: 'external_authoritative',
      sourceSystem: 'bedrock',
      sourceEntityType: 'client',
      sourceEntityId: 'src-client',
    })

    await expect(
      db.query(
        `select * from public.upsert_business_entity_relation($1, $2, $3, 'belongs_to', 'domain_adapter')`,
        [workspaceId, project.id, client.id]
      )
    ).rejects.toThrow()
  })

  it('allows a retired relation to be re-established without duplicate active edges', async () => {
    const workspaceId = await workspace()
    const project = await bedrockProject(workspaceId, 'cycle-project')
    const vendor = await resolve({
      workspaceId,
      domain: 'construction',
      entityType: 'vendor',
      authority: 'external_authoritative',
      sourceSystem: 'bedrock',
      sourceEntityType: 'vendor',
      sourceEntityId: 'cycle-vendor',
    })

    const { rows: created } = await db.query<{ id: string }>(
      `select * from public.upsert_business_entity_relation($1, $2, $3, 'supplies', 'operator')`,
      [workspaceId, project.id, vendor.id]
    )
    await db.query(
      `update public.business_entity_relations set status = 'archived', archived_at = now() where id = $1`,
      [created[0].id]
    )
    const { rows: reestablished } = await db.query<{ id: string }>(
      `select * from public.upsert_business_entity_relation($1, $2, $3, 'supplies', 'operator')`,
      [workspaceId, project.id, vendor.id]
    )

    expect(reestablished[0].id).not.toBe(created[0].id)
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.business_entity_relations
        where workspace_id = $1 and status = 'active'`,
      [workspaceId]
    )
    expect(rows[0].count).toBe('1')
  })

  it('binds a workspace to one external tenant per source system and stores no secrets', async () => {
    const workspaceId = await workspace()
    await db.query(
      `insert into public.domain_source_connections (workspace_id, source_system, external_tenant_id, credential_ref)
       values ($1, 'bedrock', 'company-uuid', 'BEDROCK_ODS')`,
      [workspaceId]
    )

    await expect(
      db.query(
        `insert into public.domain_source_connections (workspace_id, source_system, external_tenant_id)
         values ($1, 'bedrock', 'other-company')`,
        [workspaceId]
      )
    ).rejects.toThrow()

    await expect(
      db.query(
        `insert into public.domain_source_connections (workspace_id, source_system, external_tenant_id, config)
         values ($1, 'other', 'company-uuid', '{"serviceRoleKey":"sbp_live_secret"}'::jsonb)`,
        [workspaceId]
      )
    ).rejects.toThrow()

    await expect(
      db.query(
        `insert into public.domain_source_connections (workspace_id, source_system, external_tenant_id, credential_ref)
         values ($1, 'other', 'company-uuid', 'eyJhbGciOi.JIUzI1NiIs InR5cCI6')`,
        [workspaceId]
      )
    ).rejects.toThrow()
  })

  it('keeps entity identity free of the source tenant identifier', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'business_entities'`
    )
    const columns = rows.map((row) => row.column_name)
    expect(columns).not.toContain('source_company_id')
    expect(columns).not.toContain('external_tenant_id')
  })

  it('deletes entities and their relations with the workspace', async () => {
    const workspaceId = await workspace()
    const project = await bedrockProject(workspaceId, 'cascade-project')
    const client = await resolve({
      workspaceId,
      domain: 'construction',
      entityType: 'client',
      authority: 'external_authoritative',
      sourceSystem: 'bedrock',
      sourceEntityType: 'client',
      sourceEntityId: 'cascade-client',
    })
    await db.query(
      `select * from public.upsert_business_entity_relation($1, $2, $3, 'belongs_to', 'operator')`,
      [workspaceId, project.id, client.id]
    )

    await db.query('delete from public.customers where id = $1', [workspaceId])

    const { rows } = await db.query<{ entities: string; relations: string }>(
      `select
         (select count(*)::text from public.business_entities where workspace_id = $1) as entities,
         (select count(*)::text from public.business_entity_relations where workspace_id = $1) as relations`,
      [workspaceId]
    )
    expect(rows[0].entities).toBe('0')
    expect(rows[0].relations).toBe('0')
  })
})
