import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { isReportable } from '@/lib/caye-agent/workspace-feed'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { BedrockAdapter } from '@/lib/domain-adapters/bedrock/adapter'
import { BedrockPurchaseOrderChangeSource } from '@/lib/domain-adapters/bedrock/change-source'
import type { BedrockReadProvider, BedrockRow } from '@/lib/domain-adapters/bedrock/provider'
import {
  InMemoryDomainSnapshotStore,
  type DomainSnapshotStore,
} from '@/lib/domain-adapters/bedrock/snapshot-store'
import type { BedrockConnection, BedrockConnectionResolver } from '@/lib/domain-adapters/bedrock/types'
import { runDomainEventBridge } from '@/lib/domain-events/bridge'
import { withPendingObservationFlush } from '@/lib/domain-events/checkpoints'
import { readIngestResult } from '@/lib/domain-events/sink'
import { toWorkspaceEventInsert } from '@/lib/domain-events/workspace-event'
import type {
  DomainCheckpointStore,
  DomainEntityResolver,
  DomainEventSink,
  DomainEventWriteResult,
  DomainSyncCheckpoint,
  NormalizedDomainEvent,
} from '@/lib/domain-events/types'
import { businessEntityIdFromWorkspaceEvent } from '@/lib/domain/workspace-events'

/**
 * The Bedrock -> Caye vertical slice, end to end, against a real Postgres.
 *
 * This test exists because the pieces were built independently and every
 * seam between them was previously asserted only in prose or against mocks.
 * The kernel's `resolve_business_entity`, the bridge's
 * `ingest_external_domain_event`, and the change source's cursor/fingerprint
 * logic all run here for real, in migration order, so a contract that only
 * held on paper fails loudly.
 *
 * Bedrock itself is a fixture. The point is never to touch a real
 * TropiTrack database — the fixture reproduces the live schema's relevant
 * columns and the `set_updated_at` behaviour that makes polling sound.
 */

const SOURCE_SYSTEM = 'bedrock'
const COMPANY_A = 'company-a'
const COMPANY_B = 'company-b'
const STREAM = 'purchase_orders'

/** Mirrors the live Bedrock purchase_orders columns this slice depends on. */
type FixturePurchaseOrder = {
  id: string
  company_id: string
  project_id: string | null
  vendor_id: string
  po_number: string
  status: string
  order_date: string | null
  expected_delivery_date: string | null
  actual_delivery_date: string | null
  subtotal: number
  total_amount: number
  approved_at: string | null
  updated_at: string
}

/**
 * A stand-in for Bedrock that enforces the one property the real system
 * enforces and this integration leans on: every read is company-scoped, and a
 * wrong company yields nothing rather than another tenant's row.
 */
class FixtureBedrockProvider implements BedrockReadProvider {
  readonly rows = new Map<string, FixturePurchaseOrder>()
  readonly projects = new Map<string, BedrockRow>()
  readonly vendors = new Map<string, BedrockRow>()

  put(row: FixturePurchaseOrder) {
    this.rows.set(row.id, { ...row })
  }

  /** Applies an update the way the live `set_updated_at` trigger would. */
  patch(id: string, changes: Partial<FixturePurchaseOrder>, updatedAt: string) {
    const existing = this.rows.get(id)
    if (!existing) throw new Error(`fixture purchase order ${id} does not exist`)
    this.rows.set(id, { ...existing, ...changes, updated_at: updatedAt })
  }

  async listPurchaseOrdersChangedSince(
    companyId: string,
    after: { updatedAt: string; id: string } | null,
    limit: number,
  ): Promise<BedrockRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.company_id === companyId)
      .filter((row) =>
        !after ||
        row.updated_at > after.updatedAt ||
        (row.updated_at === after.updatedAt && row.id > after.id),
      )
      .sort((a, b) => (a.updated_at === b.updated_at ? a.id.localeCompare(b.id) : a.updated_at.localeCompare(b.updated_at)))
      .slice(0, limit)
      .map((row) => ({ ...row }))
  }

  async getPurchaseOrder(companyId: string, id: string) {
    const row = this.rows.get(id)
    return row && row.company_id === companyId ? { ...row } : null
  }

  async getProject(companyId: string, id: string) {
    const row = this.projects.get(id)
    return row && row.company_id === companyId ? { ...row } : null
  }

  async getVendor(companyId: string, id: string) {
    const row = this.vendors.get(id)
    return row && row.company_id === companyId ? { ...row } : null
  }

  async getPurchaseOrderItems() { return [] }
  async health(companyId: string) { return { id: companyId, name: 'ODS Construction' } }
  async listProjects() { return [] }
  async listClients() { return [] }
  async getClient() { return null }
  async getWorker() { return null }
  async listProjectTimeEntries() { return [] }
  async getPayPeriod() { return null }
  async listPayrollEntries() { return [] }
  async getEstimate() { return null }
  async listProjectEstimates() { return [] }
  async getEstimateSections() { return [] }
  async getEstimateLineItems() { return [] }
  async listProjectPurchaseOrders() { return [] }
  async listProjectReceipts() { return [] }
  async getReceiptLineItems() { return [] }
}

describe('Bedrock purchase order -> Caye workspace event (PGlite)', () => {
  let db: PGlite
  let workspaceId: string
  let otherWorkspaceId: string
  let bedrock: FixtureBedrockProvider
  let snapshots: DomainSnapshotStore

  /** Kernel entity resolution, driven through the real SQL function. */
  const resolver: DomainEntityResolver = {
    async resolve(input) {
      // Tenant binding is checked against domain_source_connections, exactly
      // where the kernel says it belongs — never folded into entity identity.
      const { rows: connections } = await db.query<{ external_tenant_id: string }>(
        `select external_tenant_id from public.domain_source_connections
          where workspace_id = $1 and source_system = $2 and status = 'active'`,
        [input.workspaceId, input.sourceSystem],
      )
      if (connections.length === 0) throw new Error(`workspace ${input.workspaceId} has no active ${input.sourceSystem} connection`)
      if (connections[0].external_tenant_id !== input.sourceCompanyId) {
        throw new Error(`${input.sourceSystem} tenant mismatch for workspace ${input.workspaceId}`)
      }

      const { rows } = await db.query<{ id: string; entity_type: string }>(
        `select * from public.resolve_business_entity($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          input.workspaceId,
          'construction',
          input.sourceEntityType,
          'external_authoritative',
          input.sourceSystem,
          input.sourceEntityType,
          input.sourceEntityId,
          null,
          null,
        ],
      )
      return rows.length ? { entityId: rows[0].id, entityType: rows[0].entity_type } : null
    },
  }

  /** Projection through the real ingestion function. */
  const sink: DomainEventSink = {
    async write(event: NormalizedDomainEvent): Promise<DomainEventWriteResult> {
      const envelope = toWorkspaceEventInsert(event)
      const { rows } = await db.query<{ result: unknown }>(
        `select public.ingest_external_domain_event(
           $1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10,$11,$12,$13::jsonb
         ) as result`,
        [
          event.workspaceId,
          event.sourceSystem,
          event.sourceCompanyId,
          event.sourceEntityType,
          event.sourceEntityId,
          event.cayeEntityId ?? null,
          event.type,
          event.occurredAt,
          event.observedAt,
          event.idempotencyKey,
          event.sourceVersion ?? null,
          envelope.actor_kind,
          JSON.stringify(envelope.payload),
        ],
      )
      return readIngestResult(rows[0].result)
    },
  }

  const checkpoints: DomainCheckpointStore = {
    async load(input) {
      const { rows } = await db.query<{ cursor: { value: string; watermark: string | null } | null }>(
        `select cursor from public.domain_sync_cursors
          where workspace_id=$1 and source_system=$2 and source_company_id=$3 and stream=$4`,
        [input.workspaceId, input.sourceSystem, input.sourceCompanyId, input.stream],
      )
      return { ...input, cursor: rows[0]?.cursor ?? null }
    },
    async commit(checkpoint: DomainSyncCheckpoint) {
      await db.query(
        `insert into public.domain_sync_cursors
           (workspace_id, source_system, source_company_id, stream, cursor, watermark)
         values ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
         on conflict (workspace_id, source_system, source_company_id, stream)
         do update set cursor = excluded.cursor, watermark = excluded.watermark, updated_at = now()`,
        [
          checkpoint.workspaceId,
          checkpoint.sourceSystem,
          checkpoint.sourceCompanyId,
          checkpoint.stream,
          JSON.stringify(checkpoint.cursor),
          checkpoint.cursor?.watermark ?? null,
        ],
      )
    },
  }

  function makeSource(overrides: { workspaceId?: string; companyId?: string } = {}) {
    return new BedrockPurchaseOrderChangeSource({
      workspaceId: overrides.workspaceId ?? workspaceId,
      companyId: overrides.companyId ?? COMPANY_A,
      provider: bedrock,
      snapshots,
    })
  }

  async function sync(source = makeSource(), targetWorkspaceId = workspaceId, companyId = COMPANY_A) {
    return runDomainEventBridge({
      workspaceId: targetWorkspaceId,
      sourceSystem: SOURCE_SYSTEM,
      sourceCompanyId: companyId,
      source,
      resolver,
      sink,
      checkpoints: withPendingObservationFlush(checkpoints, source),
    })
  }

  async function events(type?: string) {
    const { rows } = await db.query<{
      id: string
      type: string
      actor_kind: string
      occurred_at: string
      subject_table: string
      subject_id: string
      payload: Record<string, unknown>
    }>(
      `select id, type, actor_kind, occurred_at, subject_table, subject_id, payload
         from public.workspace_events
        where workspace_id = $1 ${type ? 'and type = $2' : ''}
        order by id`,
      type ? [workspaceId, type] : [workspaceId],
    )
    return rows
  }

  beforeAll(async () => {
    db = new PGlite()

    // Minimal stand-ins for the tables the three migrations reference. The
    // workspace_events definition reproduces 20260807d plus the actor_kind
    // widening from 20260807e, which is what production actually has.
    await db.exec(`
      create table public.customers (id uuid primary key default gen_random_uuid());
      create table public.business_artifacts (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references public.customers(id) on delete cascade
      );
      create table public.workspace_events (
        id bigint generated always as identity primary key,
        workspace_id uuid not null,
        occurred_at timestamptz not null,
        type text not null,
        actor_kind text not null check (actor_kind in ('outside','caye','operator','system','unknown')),
        is_failure boolean not null default false,
        subject_table text,
        subject_id text,
        conversation_id uuid,
        payload jsonb not null default '{}'::jsonb,
        origin text not null default 'trigger' check (origin in ('trigger','app')),
        created_at timestamptz not null default now()
      );
      create table public.business_facts (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null
      );
      do $$ begin
        if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
        if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
        if not exists (select from pg_roles where rolname='service_role') then create role service_role; end if;
      end $$;
    `)

    const dir = join(__dirname, '..', '..', 'supabase', 'migrations')
    // Applied in the same order the manifest sorts them, so a real ordering
    // problem between the kernel and the bridge would surface here.
    for (const file of [
      '20260901190000_business_entity_kernel.sql',
      '20260901_domain_event_projection_bridge.sql',
      '20260902000000_domain_change_source_snapshots.sql',
      '20260902043000_domain_integration_review_fixes.sql',
    ]) {
      await db.exec(readFileSync(join(dir, file), 'utf8'))
    }
  })

  afterAll(async () => { await db.close() })

  beforeEach(async () => {
    await db.exec(`
      truncate public.workspace_events;
      truncate public.domain_entity_observation_state;
      truncate public.domain_sync_cursors;
      delete from public.business_entity_relations;
      delete from public.business_facts;
      delete from public.domain_source_connections;
      delete from public.business_entities;
      delete from public.customers;
    `)

    const { rows } = await db.query<{ id: string }>('insert into public.customers default values returning id')
    workspaceId = rows[0].id
    const { rows: other } = await db.query<{ id: string }>('insert into public.customers default values returning id')
    otherWorkspaceId = other[0].id

    await db.query(
      `insert into public.domain_source_connections
         (workspace_id, source_system, external_tenant_id, status, credential_ref, config)
       values ($1,'bedrock',$2,'active','bedrock_ods', '{"supabase_url":"https://bedrock.invalid"}'::jsonb)`,
      [workspaceId, COMPANY_A],
    )
    await db.query(
      `insert into public.domain_source_connections
         (workspace_id, source_system, external_tenant_id, status, credential_ref, config)
       values ($1,'bedrock',$2,'active','bedrock_other', '{"supabase_url":"https://bedrock.invalid"}'::jsonb)`,
      [otherWorkspaceId, COMPANY_B],
    )

    bedrock = new FixtureBedrockProvider()
    bedrock.projects.set('project-reef', { id: 'project-reef', company_id: COMPANY_A, name: 'Off the Reef' })
    bedrock.vendors.set('vendor-1', { id: 'vendor-1', company_id: COMPANY_A, name: 'Island Supply' })
    bedrock.put({
      id: 'po-abc',
      company_id: COMPANY_A,
      project_id: 'project-reef',
      vendor_id: 'vendor-1',
      po_number: 'PO-1042',
      status: 'approved',
      order_date: '2026-08-20',
      expected_delivery_date: '2026-09-05',
      actual_delivery_date: null,
      subtotal: 4200,
      total_amount: 4620,
      approved_at: '2026-08-21T14:00:00.000Z',
      updated_at: '2026-08-21T14:00:00.000Z',
    })
    snapshots = new InMemoryDomainSnapshotStore()
  })

  // -- C. Bootstrap correctness -------------------------------------------

  it('bootstraps an existing approved PO as an observation, never as a transition', async () => {
    const result = await sync()

    expect(result.emitted).toBe(1)
    const rows = await events()
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('domain.purchase_order.bootstrap_observed')

    // No claim that anything just happened to it.
    expect(rows[0].payload.change_kind).toBe('bootstrap')
    expect(rows[0].payload.changes).toEqual([])
    expect(isReportable({ actorKind: rows[0].actor_kind, isFailure: false })).toBe(false)

    // And not attributable to the outside world, so the existing workspace
    // feed (actor_kind 'outside' or is_failure) will not raise it.
    expect(rows[0].actor_kind).toBe('system')

    // Nothing anywhere claims a status transition occurred.
    const transitions = await events('domain.purchase_order.status_changed')
    expect(transitions).toHaveLength(0)
  })

  // -- A. Entity idempotency ----------------------------------------------

  it('resolves one canonical identity for a PO no matter how often it is processed', async () => {
    await sync()
    const first = businessEntityIdFromWorkspaceEvent((await events())[0])
    expect(first).toBeTruthy()

    // Re-observe with a fresh cursor and fresh change-detection state: the
    // canonical id must come from the database, not from process memory.
    await db.exec('truncate public.domain_sync_cursors')
    snapshots = new InMemoryDomainSnapshotStore()
    await sync()

    const { rows } = await db.query<{ count: number }>(
      `select count(*) as count from public.business_entities
        where workspace_id=$1 and source_system='bedrock' and source_entity_type='purchase_order' and source_entity_id='po-abc'`,
      [workspaceId],
    )
    expect(Number(rows[0].count)).toBe(1)

    const { rows: entity } = await db.query<{ id: string; authority: string; domain: string }>(
      `select id, authority, domain from public.business_entities
        where workspace_id=$1 and source_entity_id='po-abc'`,
      [workspaceId],
    )
    expect(entity[0].id).toBe(first)
    expect(entity[0].authority).toBe('external_authoritative')
    expect(entity[0].domain).toBe('construction')
  })

  // -- D. Real transition correctness --------------------------------------

  it('turns approved -> ordered into exactly one status_changed event carrying identity and provenance', async () => {
    await sync()
    const entityId = businessEntityIdFromWorkspaceEvent((await events())[0])

    bedrock.patch('po-abc', { status: 'ordered' }, '2026-08-25T09:30:00.000Z')
    const result = await sync()
    expect(result.emitted).toBe(1)

    const transitions = await events('domain.purchase_order.status_changed')
    expect(transitions).toHaveLength(1)

    const event = transitions[0]
    const payload = event.payload as Record<string, any>

    // Semantic previous/current, not a bare "it is ordered now".
    expect(payload.changes).toEqual([{ field: 'status', previous: 'approved', current: 'ordered' }])
    expect(payload.change_kind).toBe('transition')

    // Caye identity, resolved to the same canonical uuid as the bootstrap.
    expect(businessEntityIdFromWorkspaceEvent(event)).toBe(entityId)
    expect(payload.entity.resolution).toBe('resolved')

    // Source provenance survives projection.
    expect(payload.source.system).toBe('bedrock')
    expect(payload.source.entity_type).toBe('purchase_order')
    expect(payload.source.entity_id).toBe('po-abc')
    expect(payload.source.company_id).toBe(COMPANY_A)
    expect(event.subject_table).toBe('external_domain_entity')
    expect(event.subject_id).toBe('bedrock:purchase_order:po-abc')

    // Occurred time is Bedrock's, observed time is Caye's, and they are distinct facts.
    expect(new Date(event.occurred_at).toISOString()).toBe('2026-08-25T09:30:00.000Z')
    expect(new Date(payload.observed_at as string).getTime()).toBeGreaterThanOrEqual(
      new Date(event.occurred_at).getTime(),
    )

    // A real change from the source system IS outside activity.
    expect(event.actor_kind).toBe('outside')
  })

  it('emits nothing when updated_at moves but no tracked field changed', async () => {
    await sync()
    bedrock.patch('po-abc', {}, '2026-08-26T10:00:00.000Z')
    const result = await sync()
    expect(result.emitted).toBe(0)
    expect(await events('domain.purchase_order.status_changed')).toHaveLength(0)
  })

  // -- B. Event idempotency ------------------------------------------------

  it('classifies a replayed source change as a duplicate rather than a second event', async () => {
    await sync()
    bedrock.patch('po-abc', { status: 'ordered' }, '2026-08-25T09:30:00.000Z')
    await sync()

    const before = await events('domain.purchase_order.status_changed')
    expect(before).toHaveLength(1)

    // Replay the identical change through the sink, as a retried worker would.
    const source = makeSource()
    const replayStore = new InMemoryDomainSnapshotStore()
    const replaySource = new BedrockPurchaseOrderChangeSource({
      workspaceId, companyId: COMPANY_A, provider: bedrock, snapshots: replayStore,
    })
    void source
    // Seed the replay store with the pre-transition snapshot so the source
    // re-derives the very same approved -> ordered change.
    await replayStore.saveMany([
      {
        workspaceId, sourceSystem: SOURCE_SYSTEM, sourceCompanyId: COMPANY_A,
        sourceEntityType: 'purchase_order', sourceEntityId: 'po-abc',
        snapshot: {
          fingerprint: 'stale-fingerprint',
          fields: { status: 'approved', project_id: 'project-reef', vendor_id: 'vendor-1', po_number: 'PO-1042', order_date: '2026-08-20', expected_delivery_date: '2026-09-05', actual_delivery_date: null, subtotal: 4200, total_amount: 4620, approved_at: '2026-08-21T14:00:00.000Z' },
          observedAt: '2026-08-21T14:00:00.000Z',
          sourceUpdatedAt: '2026-08-21T14:00:00.000Z',
        },
      },
    ])
    await db.exec('truncate public.domain_sync_cursors')

    const replay = await runDomainEventBridge({
      workspaceId, sourceSystem: SOURCE_SYSTEM, sourceCompanyId: COMPANY_A,
      source: replaySource, resolver, sink,
      checkpoints: withPendingObservationFlush(checkpoints, replaySource),
    })

    expect(replay.duplicates).toBe(1)
    expect(replay.emitted).toBe(0)
    expect(await events('domain.purchase_order.status_changed')).toHaveLength(1)
  })

  // -- E. Stale / out-of-order handling ------------------------------------

  it('suppresses an older observation after a newer one and never regresses the watermark', async () => {
    await sync()
    bedrock.patch('po-abc', { status: 'ordered' }, '2026-08-25T09:30:00.000Z')
    await sync()

    const { rows: watermarkBefore } = await db.query<{ last_occurred_at: string }>(
      `select last_occurred_at from public.domain_entity_observation_state
        where workspace_id=$1 and source_entity_id='po-abc'`,
      [workspaceId],
    )

    // An older transition arrives late — a delayed worker, or a re-scan of a
    // replica that had not caught up.
    const stale = await sink.write({
      workspaceId,
      type: 'domain.purchase_order.status_changed',
      sourceSystem: SOURCE_SYSTEM,
      sourceCompanyId: COMPANY_A,
      sourceEntityType: 'purchase_order',
      sourceEntityId: 'po-abc',
      sourceVersion: 'older-observation',
      cayeEntityId: businessEntityIdFromWorkspaceEvent((await events())[0]),
      occurredAt: '2026-08-22T08:00:00.000Z',
      observedAt: new Date().toISOString(),
      idempotencyKey: 'deliberately-distinct-older-key',
      actor: { kind: 'external' },
      changeKind: 'transition',
      changes: [{ field: 'status', previous: 'submitted', current: 'approved' }],
      relatedEntities: [],
      sourceMetadata: {},
      attentionEligible: true,
    })

    expect(stale.status).toBe('stale')
    expect(await events('domain.purchase_order.status_changed')).toHaveLength(1)

    const { rows: watermarkAfter } = await db.query<{ last_occurred_at: string }>(
      `select last_occurred_at from public.domain_entity_observation_state
        where workspace_id=$1 and source_entity_id='po-abc'`,
      [workspaceId],
    )
    expect(new Date(watermarkAfter[0].last_occurred_at).toISOString())
      .toBe(new Date(watermarkBefore[0].last_occurred_at).toISOString())
  })

  // -- F. Related entity resolution ----------------------------------------

  it('resolves the PO project and vendor to their own canonical identities', async () => {
    await sync()
    bedrock.patch('po-abc', { status: 'ordered' }, '2026-08-25T09:30:00.000Z')
    await sync()

    const event = (await events('domain.purchase_order.status_changed'))[0]
    const relatedEntities = (event.payload as Record<string, any>).related_entities as Array<{
      role: string; sourceEntityType: string; sourceEntityId: string; cayeEntityId: string | null
    }>

    const project = relatedEntities.find((r) => r.role === 'project')
    const vendor = relatedEntities.find((r) => r.role === 'vendor')
    expect(project?.sourceEntityId).toBe('project-reef')
    expect(vendor?.sourceEntityId).toBe('vendor-1')

    // Canonical Caye uuids, not anonymous blobs.
    expect(project?.cayeEntityId).toBeTruthy()
    expect(vendor?.cayeEntityId).toBeTruthy()
    expect(project?.cayeEntityId).not.toBe(vendor?.cayeEntityId)
    expect(project?.cayeEntityId).not.toBe(businessEntityIdFromWorkspaceEvent(event))

    const { rows } = await db.query<{ entity_type: string; source_entity_id: string }>(
      `select entity_type, source_entity_id from public.business_entities
        where workspace_id=$1 order by entity_type`,
      [workspaceId],
    )
    expect(rows.map((r) => r.entity_type)).toEqual(['project', 'purchase_order', 'vendor'])
  })

  // -- G. Current state remains external ------------------------------------

  it('reads authoritative current PO state from Bedrock, never from business_entities', async () => {
    await sync()
    bedrock.patch('po-abc', { status: 'ordered' }, '2026-08-25T09:30:00.000Z')
    await sync()

    const connection: BedrockConnection = {
      workspaceId, companyId: COMPANY_A,
      supabaseUrl: 'https://bedrock.invalid', serviceRoleKey: 'unused-by-the-fixture',
    }
    const connectionResolver: BedrockConnectionResolver = {
      resolve: async (id) => (id === workspaceId ? connection : null),
    }
    const adapter = new BedrockAdapter(connectionResolver, () => bedrock)

    // Bedrock moves on again WITHOUT any projection running.
    bedrock.patch('po-abc', { status: 'received', actual_delivery_date: '2026-09-02' }, '2026-09-02T12:00:00.000Z')

    const current = await adapter.getPurchaseOrder(workspaceId, 'po-abc')
    expect(current.status).toBe('received')
    expect(current.authority).toBe('external_authoritative')
    expect(current.sourceSystem).toBe('bedrock')

    // Caye's own row still holds identity only — no status, no amounts.
    const { rows } = await db.query<Record<string, unknown>>(
      `select * from public.business_entities where workspace_id=$1 and source_entity_id='po-abc'`,
      [workspaceId],
    )
    const columns = Object.keys(rows[0])
    for (const leaked of ['status_value', 'total_amount', 'subtotal', 'order_date', 'vendor_id', 'project_id']) {
      expect(columns).not.toContain(leaked)
    }
    // The one `status` column it does have is Caye's own lifecycle, not Bedrock's.
    expect(rows[0].status).toBe('active')
  })

  // -- H. Workspace / company isolation -------------------------------------

  it('fails closed when a workspace is offered another company\'s purchase order', async () => {
    // A change source mis-scoped to company B, running for workspace A.
    const mismatched = makeSource({ companyId: COMPANY_B })
    await expect(
      runDomainEventBridge({
        workspaceId, sourceSystem: SOURCE_SYSTEM, sourceCompanyId: COMPANY_A,
        source: mismatched, resolver, sink,
        checkpoints: withPendingObservationFlush(checkpoints, mismatched),
      }),
    ).rejects.toThrow(/scope/i)

    expect(await events()).toHaveLength(0)
  })

  it('refuses to resolve an entity for a company the workspace is not bound to', async () => {
    await expect(
      resolver.resolve({
        workspaceId,
        sourceSystem: SOURCE_SYSTEM,
        sourceCompanyId: COMPANY_B,
        sourceEntityType: 'purchase_order',
        sourceEntityId: 'po-belonging-to-b',
      }),
    ).rejects.toThrow(/tenant mismatch/i)

    const { rows } = await db.query<{ count: number }>(
      `select count(*) as count from public.business_entities where source_entity_id='po-belonging-to-b'`,
    )
    expect(Number(rows[0].count)).toBe(0)
  })

  it('never returns another company\'s row from the change source', async () => {
    bedrock.put({
      id: 'po-other-company', company_id: COMPANY_B, project_id: null, vendor_id: 'vendor-9',
      po_number: 'PO-9', status: 'approved', order_date: null, expected_delivery_date: null,
      actual_delivery_date: null, subtotal: 1, total_amount: 1, approved_at: null,
      updated_at: '2026-08-30T00:00:00.000Z',
    })
    await sync()

    const rows = await events()
    for (const row of rows) expect(row.subject_id).not.toContain('po-other-company')
    expect(rows).toHaveLength(1)
  })

  // -- I. No accidental knowledge writes -------------------------------------

  it('creates no business_fact while projecting a PO change', async () => {
    await sync()
    bedrock.patch('po-abc', { status: 'ordered' }, '2026-08-25T09:30:00.000Z')
    await sync()

    const { rows } = await db.query<{ count: number }>('select count(*) as count from public.business_facts')
    expect(Number(rows[0].count)).toBe(0)
  })

  // -- Phase 7. Existing continuous perception --------------------------------

  it('produces a status_changed event the existing workspace feed treats as reportable', async () => {
    await sync()
    bedrock.patch('po-abc', { status: 'ordered' }, '2026-08-25T09:30:00.000Z')
    await sync()

    // This is the exact filter lib/caye-agent/workspace-feed.ts pushes down to
    // Postgres, so qualifying here means the event is visible to the existing
    // perception path with no new bus and no new consumer.
    const { rows } = await db.query<{ type: string }>(
      `select type from public.workspace_events
        where workspace_id = $1 and (actor_kind = 'outside' or is_failure = true)`,
      [workspaceId],
    )
    expect(rows.map((r) => r.type)).toEqual(['domain.purchase_order.status_changed'])
  })

  // -- Cursor durability -------------------------------------------------------

  it('advances a durable, resumable cursor and does not re-emit settled rows', async () => {
    await sync()
    const { rows: first } = await db.query<{ cursor: { value: string } }>(
      `select cursor from public.domain_sync_cursors where workspace_id=$1 and stream=$2`,
      [workspaceId, STREAM],
    )
    expect(first[0].cursor.value).toBe('2026-08-21T14:00:00.000Z|po-abc')

    const second = await sync()
    expect(second.scanned).toBe(0)
    expect(second.emitted).toBe(0)
  })
})
