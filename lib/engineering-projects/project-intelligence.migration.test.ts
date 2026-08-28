import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

describe('engineering project intelligence migration (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table public.customers (id uuid primary key default gen_random_uuid());
      create table public.business_artifacts (
        id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.customers(id)
      );
      create table public.caye_operator_messages (
        id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.customers(id),
        direction text not null default 'inbound', origin text
      );
      do $$ begin
        if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end $$;
    `)
    const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations')
    await db.exec(readFileSync(join(migrationsDir, '20260828_property_intelligence_v1.sql'), 'utf8'))
    await db.exec(readFileSync(join(migrationsDir, '20260828_property_intelligence_v1_provenance_scope.sql'), 'utf8'))
    await db.exec(readFileSync(join(migrationsDir, '20260829_engineering_project_intelligence_v1.sql'), 'utf8'))
  })

  afterAll(async () => { await db.close() })

  async function workspace() {
    const { rows } = await db.query<{ id: string }>('insert into public.customers default values returning id')
    return rows[0].id
  }
  async function property(workspaceId: string, name: string) {
    const { rows } = await db.query<{ id: string }>('insert into public.physical_properties (workspace_id,name) values ($1,$2) returning id',[workspaceId,name])
    return rows[0].id
  }
  async function observation(workspaceId: string, propertyId: string, key = 'storage') {
    const { rows } = await db.query<{ id: string }>(`insert into public.property_observations (workspace_id,property_id,observation_key,numeric_value,unit,provenance_status) values ($1,$2,$3,2000,'gallon','operator_confirmed') returning id`,[workspaceId,propertyId,key])
    return rows[0].id
  }
  async function project(workspaceId: string, propertyId: string, name = 'Water resilience') {
    const { rows } = await db.query<{ id: string }>(`insert into public.engineering_projects (workspace_id,property_id,name,objective) values ($1,$2,$3,'Reduce delivered-water dependency') returning id`,[workspaceId,propertyId,name])
    return rows[0].id
  }

  it('applies cleanly and enables RLS on every project-intelligence table', async () => {
    const names = ['engineering_projects','engineering_project_baselines','engineering_project_baseline_items','engineering_project_alternatives','engineering_project_predictions','engineering_project_decisions','engineering_project_execution_evidence','engineering_project_outcomes','engineering_project_verdicts']
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(`select relname,relrowsecurity from pg_class where relname = any($1::text[]) order by relname`,[names])
    expect(rows).toHaveLength(names.length)
    expect(rows.every((row) => row.relrowsecurity)).toBe(true)
  })

  it('rejects a baseline observation from a different property', async () => {
    const ws = await workspace(); const a = await property(ws,'A'); const b = await property(ws,'B'); const p = await project(ws,a); const obs = await observation(ws,b)
    const baseline = await db.query<{ id: string }>(`insert into public.engineering_project_baselines (workspace_id,project_id,status) values ($1,$2,'draft') returning id`,[ws,p])
    await expect(db.query(`insert into public.engineering_project_baseline_items (workspace_id,baseline_id,property_observation_id) values ($1,$2,$3)`,[ws,baseline.rows[0].id,obs])).rejects.toThrow(/baseline observation is not part/)
  })

  it('makes a frozen baseline and its items immutable', async () => {
    const ws = await workspace(); const prop = await property(ws,'Frozen'); const p = await project(ws,prop); const obs = await observation(ws,prop)
    const baseline = await db.query<{ id: string }>(`insert into public.engineering_project_baselines (workspace_id,project_id,status) values ($1,$2,'draft') returning id`,[ws,p])
    await db.query(`insert into public.engineering_project_baseline_items (workspace_id,baseline_id,property_observation_id) values ($1,$2,$3)`,[ws,baseline.rows[0].id,obs])
    await db.query(`update public.engineering_project_baselines set status='frozen', frozen_at=now() where id=$1`,[baseline.rows[0].id])
    await expect(db.query(`delete from public.engineering_project_baseline_items where baseline_id=$1`,[baseline.rows[0].id])).rejects.toThrow(/immutable/)
    await expect(db.query(`update public.engineering_project_baselines set notes='rewrite history' where id=$1`,[baseline.rows[0].id])).rejects.toThrow(/immutable/)
  })

  it('rejects predictions attached to an alternative from another project', async () => {
    const ws = await workspace(); const prop = await property(ws,'Alternatives'); const p1 = await project(ws,prop,'P1'); const p2 = await project(ws,prop,'P2')
    const alt = await db.query<{ id: string }>(`insert into public.engineering_project_alternatives (workspace_id,project_id,alternative_key,title,description) values ($1,$2,'gutters','Gutters','Expand roof capture') returning id`,[ws,p1])
    await expect(db.query(`insert into public.engineering_project_predictions (workspace_id,project_id,alternative_id,metric_key,numeric_value,unit,provenance_status) values ($1,$2,$3,'captured_rain',800,'gallon','estimated')`,[ws,p2,alt.rows[0].id])).rejects.toThrow(/prediction alternative is not part/)
  })

  it('requires execution evidence to come from an inbound dashboard founder message in the same workspace', async () => {
    const wsA = await workspace(); const wsB = await workspace(); const prop = await property(wsA,'Execution'); const p = await project(wsA,prop)
    const message = await db.query<{ id: string }>(`insert into public.caye_operator_messages (workspace_id,direction,origin) values ($1,'inbound','dashboard') returning id`,[wsB])
    await expect(db.query(`insert into public.engineering_project_execution_evidence (workspace_id,project_id,evidence_type,source_message_id,notes,occurred_at) values ($1,$2,'operator_confirmation',$3,'Installed gutters',now())`,[wsA,p,message.rows[0].id])).rejects.toThrow(/execution source/)
  })

  it('allows a coherent project baseline → alternative → prediction → decision → execution → outcome chain', async () => {
    const ws = await workspace(); const prop = await property(ws,'Coherent'); const p = await project(ws,prop); const baselineObs = await observation(ws,prop,'baseline_storage')
    const baseline = await db.query<{ id: string }>(`insert into public.engineering_project_baselines (workspace_id,project_id,status) values ($1,$2,'draft') returning id`,[ws,p])
    await db.query(`insert into public.engineering_project_baseline_items (workspace_id,baseline_id,property_observation_id) values ($1,$2,$3)`,[ws,baseline.rows[0].id,baselineObs])
    await db.query(`update public.engineering_project_baselines set status='frozen', frozen_at=now() where id=$1`,[baseline.rows[0].id])
    const alt = await db.query<{ id: string }>(`insert into public.engineering_project_alternatives (workspace_id,project_id,alternative_key,title,description) values ($1,$2,'capture','Expand capture','Complete gutter coverage') returning id`,[ws,p])
    await db.query(`insert into public.engineering_project_predictions (workspace_id,project_id,alternative_id,metric_key,numeric_value,unit,provenance_status) values ($1,$2,$3,'captured_rain',800,'gallon','estimated')`,[ws,p,alt.rows[0].id])
    const message = await db.query<{ id: string }>(`insert into public.caye_operator_messages (workspace_id,direction,origin) values ($1,'inbound','dashboard') returning id`,[ws])
    await db.query(`insert into public.engineering_project_decisions (workspace_id,project_id,alternative_id,source_message_id) values ($1,$2,$3,$4)`,[ws,p,alt.rows[0].id,message.rows[0].id])
    await db.query(`insert into public.engineering_project_execution_evidence (workspace_id,project_id,alternative_id,evidence_type,source_message_id,notes,occurred_at) values ($1,$2,$3,'operator_confirmation',$4,'Founder confirmed installation',now())`,[ws,p,alt.rows[0].id,message.rows[0].id])
    const outcome = await observation(ws,prop,'captured_rain')
    const { rows } = await db.query<{ id: string }>(`insert into public.engineering_project_outcomes (workspace_id,project_id,metric_key,property_observation_id) values ($1,$2,'captured_rain',$3) returning id`,[ws,p,outcome])
    expect(rows[0].id).toBeTruthy()
  })
})
