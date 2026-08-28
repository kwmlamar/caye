import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

describe('property intelligence migration (PGlite)', () => {
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
    await db.exec(readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '20260828_property_intelligence_v1.sql'), 'utf8'))
  })

  afterAll(async () => { await db.close() })

  async function workspace() {
    const { rows } = await db.query<{ id: string }>('insert into public.customers default values returning id')
    return rows[0].id
  }

  async function property(workspaceId: string, name: string) {
    const { rows } = await db.query<{ id: string }>(
      'insert into public.physical_properties (workspace_id, name) values ($1, $2) returning id',
      [workspaceId, name]
    )
    return rows[0].id
  }

  it('applies cleanly and enables RLS on every property table', async () => {
    const names = ['physical_properties','property_structures','property_systems','property_assets','property_observations','property_artifact_links']
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname = any($1::text[]) order by relname`,
      [names]
    )
    expect(rows).toHaveLength(names.length)
    expect(rows.every((row) => row.relrowsecurity)).toBe(true)
  })

  it('prevents a structure from one property being attached to a system in another property', async () => {
    const workspaceId = await workspace()
    const propertyA = await property(workspaceId, 'Property A')
    const propertyB = await property(workspaceId, 'Property B')
    const { rows } = await db.query<{ id: string }>(
      `insert into public.property_structures (workspace_id, property_id, name)
       values ($1, $2, 'Main House') returning id`,
      [workspaceId, propertyA]
    )

    await expect(db.query(
      `insert into public.property_systems (workspace_id, property_id, structure_id, name, system_type)
       values ($1, $2, $3, 'Water', 'water')`,
      [workspaceId, propertyB, rows[0].id]
    )).rejects.toThrow()
  })

  it('prevents property rows from claiming a different workspace than their parent property', async () => {
    const workspaceA = await workspace()
    const workspaceB = await workspace()
    const propertyA = await property(workspaceA, 'Workspace A Property')

    await expect(db.query(
      `insert into public.property_structures (workspace_id, property_id, name)
       values ($1, $2, 'Wrong Workspace House')`,
      [workspaceB, propertyA]
    )).rejects.toThrow()
  })

  it('allows a coherent property → structure → system → asset → observation chain', async () => {
    const workspaceId = await workspace()
    const propertyId = await property(workspaceId, 'Coherent Property')
    const structure = await db.query<{ id: string }>(
      `insert into public.property_structures (workspace_id, property_id, name)
       values ($1, $2, 'Main House') returning id`,
      [workspaceId, propertyId]
    )
    const system = await db.query<{ id: string }>(
      `insert into public.property_systems (workspace_id, property_id, structure_id, name, system_type)
       values ($1, $2, $3, 'Water', 'water') returning id`,
      [workspaceId, propertyId, structure.rows[0].id]
    )
    const asset = await db.query<{ id: string }>(
      `insert into public.property_assets (workspace_id, property_id, structure_id, system_id, name, asset_type)
       values ($1, $2, $3, $4, 'Tank 1', 'water_tank') returning id`,
      [workspaceId, propertyId, structure.rows[0].id, system.rows[0].id]
    )
    const observation = await db.query<{ id: string }>(
      `insert into public.property_observations
       (workspace_id, property_id, structure_id, system_id, asset_id, observation_key, numeric_value, unit, provenance_status)
       values ($1, $2, $3, $4, $5, 'capacity', 1000, 'gallon', 'operator_confirmed') returning id`,
      [workspaceId, propertyId, structure.rows[0].id, system.rows[0].id, asset.rows[0].id]
    )

    expect(observation.rows[0].id).toBeTruthy()
  })
})
