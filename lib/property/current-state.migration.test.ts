import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

describe('property current-state projection (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table public.customers (id uuid primary key default gen_random_uuid());
      create table public.business_artifacts (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null references public.customers(id) on delete cascade
      );
      create table public.caye_operator_messages (
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
    await db.exec(readFileSync(join(migrationsDir, '20260828_property_intelligence_v1.sql'), 'utf8'))
    await db.exec(readFileSync(join(migrationsDir, '20260828_property_intelligence_v1_current_state.sql'), 'utf8'))
    await db.exec(readFileSync(join(migrationsDir, '20260828_property_intelligence_v1_provenance_scope.sql'), 'utf8'))
  })

  afterAll(async () => { await db.close() })

  it('keeps one current value per semantic subject/key across full history', async () => {
    const workspace = await db.query<{ id: string }>('insert into public.customers default values returning id')
    const workspaceId = workspace.rows[0].id
    const property = await db.query<{ id: string }>(
      `insert into public.physical_properties (workspace_id, name)
       values ($1, 'Current State Property') returning id`,
      [workspaceId]
    )
    const propertyId = property.rows[0].id
    const asset = await db.query<{ id: string }>(
      `insert into public.property_assets (workspace_id, property_id, name, asset_type)
       values ($1, $2, 'Tank 1', 'water_tank') returning id`,
      [workspaceId, propertyId]
    )
    const assetId = asset.rows[0].id

    await db.query(
      `insert into public.property_observations
       (workspace_id, property_id, asset_id, observation_key, numeric_value, unit, provenance_status, observed_at)
       values ($1, $2, $3, 'capacity', 900, 'gallon', 'estimated', '2026-08-01T00:00:00Z')`,
      [workspaceId, propertyId, assetId]
    )
    await db.query(
      `insert into public.property_observations
       (workspace_id, property_id, asset_id, observation_key, numeric_value, unit, provenance_status, observed_at)
       values ($1, $2, $3, 'capacity', 1000, 'gallon', 'operator_confirmed', '2026-08-02T00:00:00Z')`,
      [workspaceId, propertyId, assetId]
    )

    // More than the UI/history window worth of unrelated newer facts must not
    // make the tank's still-current capacity disappear.
    for (let i = 0; i < 105; i++) {
      await db.query(
        `insert into public.property_observations
         (workspace_id, property_id, observation_key, numeric_value, unit, provenance_status, observed_at)
         values ($1, $2, $3, $4, 'count', 'observed', $5)`,
        [workspaceId, propertyId, `unrelated_${i}`, i, new Date(Date.UTC(2026, 7, 3, 0, 0, i)).toISOString()]
      )
    }

    const current = await db.query<{ numeric_value: number; provenance_status: string }>(
      `select numeric_value, provenance_status
       from public.property_current_observations
       where workspace_id = $1 and property_id = $2 and asset_id = $3 and observation_key = 'capacity'`,
      [workspaceId, propertyId, assetId]
    )

    expect(current.rows).toEqual([{ numeric_value: 1000, provenance_status: 'operator_confirmed' }])
  })
})
