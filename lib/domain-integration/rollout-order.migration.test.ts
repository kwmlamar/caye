import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// Each case builds one or more full PGlite instances and replays real
// migrations; that comfortably exceeds the 5s default when the suite runs
// these files in parallel with the rest.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/**
 * Rollout characteristics of the four review-only domain-integration
 * migrations, established by actually applying them rather than by reading
 * them.
 *
 * 20260902043000's own header says "Not applied to production. Integration
 * migrations are still review-only." These tests do not change that status;
 * they document what applying the stack would and would not do, so the
 * decision is made on evidence.
 *
 * The order below is a dependency, not a preference:
 *   kernel   creates business_entities(workspace_id, id) unique
 *   bridge   creates domain_entity_observation_state.caye_entity_id as TEXT
 *   snapshots is independent of both but sequenced by filename
 *   043000   converts that column to UUID and adds a composite FK into
 *            business_entities — so it cannot precede either.
 */

const MIGRATIONS = join(__dirname, '..', '..', 'supabase', 'migrations')
const read = (n: string) => readFileSync(join(MIGRATIONS, n), 'utf8')

const STACK = [
  '20260901190000_business_entity_kernel',
  '20260901_domain_event_projection_bridge',
  '20260902000000_domain_change_source_snapshots',
  '20260902043000_domain_integration_review_fixes',
]

/** Tables the stack references but does not create. */
const FIXTURE = `
  create schema if not exists extensions;
  create role anon; create role authenticated; create role service_role;

  create table public.customers (id uuid primary key default gen_random_uuid());
  create table public.business_artifacts (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references public.customers(id)
  );
  create table public.workspace_events (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null,
    type text not null,
    subject_type text,
    subject_id text,
    actor_kind text,
    payload jsonb not null default '{}'::jsonb,
    occurred_at timestamptz not null default now(),
    created_at timestamptz not null default now()
  );
`

async function applyStack(through = STACK.length) {
  const db = new PGlite()
  await db.exec(FIXTURE)
  for (const name of STACK.slice(0, through)) {
    await db.exec(read(`${name}.sql`))
  }
  return db
}

describe('domain-integration rollout', () => {
  it('applies cleanly in dependency order', async () => {
    const db = await applyStack()
    try {
      const { rows } = await db.query<{ relname: string }>(
        `select relname from pg_class
          where relnamespace = 'public'::regnamespace and relkind = 'r'
            and relname in ('business_entities','business_entity_relations',
                            'domain_source_connections','domain_sync_cursors',
                            'domain_entity_observation_state','domain_change_source_snapshots')
          order by relname`
      )
      expect(rows.map((r) => r.relname)).toEqual([
        'business_entities',
        'business_entity_relations',
        'domain_change_source_snapshots',
        'domain_entity_observation_state',
        'domain_source_connections',
        'domain_sync_cursors',
      ])
    } finally {
      await db.close()
    }
  })

  it('043000 cannot be applied before the bridge it alters', async () => {
    // Concrete proof of the ordering requirement, not an assumption.
    const db = new PGlite()
    try {
      await db.exec(FIXTURE)
      await db.exec(read('20260901190000_business_entity_kernel.sql'))
      await expect(db.exec(read('20260902043000_domain_integration_review_fixes.sql'))).rejects.toThrow()
    } finally {
      await db.close()
    }
  })

  it('043000 converts the bridge column from text to uuid', async () => {
    const before = await applyStack(3)
    const t1 = await before.query<{ data_type: string }>(
      `select data_type from information_schema.columns
        where table_name='domain_entity_observation_state' and column_name='caye_entity_id'`
    )
    expect(t1.rows[0].data_type).toBe('text')
    await before.close()

    const after = await applyStack(4)
    const t2 = await after.query<{ data_type: string }>(
      `select data_type from information_schema.columns
        where table_name='domain_entity_observation_state' and column_name='caye_entity_id'`
    )
    expect(t2.rows[0].data_type).toBe('uuid')
    await after.close()
  })

  it('leaves every new table RLS-enabled with no policy — service-role only', async () => {
    const db = await applyStack()
    try {
      const { rows } = await db.query<{ relname: string; rls: boolean; policies: number }>(
        `select c.relname, c.relrowsecurity as rls,
                (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
           from pg_class c
          where c.relnamespace='public'::regnamespace and c.relkind='r'
            and c.relname in ('business_entities','business_entity_relations',
                              'domain_source_connections','domain_sync_cursors',
                              'domain_entity_observation_state','domain_change_source_snapshots')
          order by c.relname`
      )
      expect(rows).toHaveLength(6)
      for (const r of rows) {
        expect(r.rls, `${r.relname} RLS`).toBe(true)
        expect(r.policies, `${r.relname} policies`).toBe(0)
      }
    } finally {
      await db.close()
    }
  })

  it('grants no privilege to anon or authenticated', async () => {
    const db = await applyStack()
    try {
      const { rows } = await db.query<{ relname: string; grantee: string }>(
        `select c.relname, r.rolname as grantee
           from pg_class c, pg_roles r
          where c.relnamespace='public'::regnamespace and c.relkind='r'
            and c.relname like any (array['business_entit%','domain_%'])
            and r.rolname in ('anon','authenticated')
            and (has_table_privilege(r.rolname, c.oid, 'SELECT')
              or has_table_privilege(r.rolname, c.oid, 'INSERT')
              or has_table_privilege(r.rolname, c.oid, 'UPDATE')
              or has_table_privilege(r.rolname, c.oid, 'DELETE'))`
      )
      expect(rows).toEqual([])
    } finally {
      await db.close()
    }
  })

  it('adds no trigger to any pre-existing table', async () => {
    // Deploying the stack must not change the behaviour of tables that are
    // already live. A trigger on workspace_events would.
    const db = await applyStack()
    try {
      const { rows } = await db.query<{ tbl: string; tgname: string }>(
        `select c.relname as tbl, t.tgname
           from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where not t.tgisinternal and c.relnamespace='public'::regnamespace
            and c.relname in ('workspace_events','business_artifacts','customers')`
      )
      expect(rows).toEqual([])
    } finally {
      await db.close()
    }
  })

  it('043000 is NOT idempotent — a second apply fails on the artifact unique key', async () => {
    // Documented, not fixed here: `add constraint ... unique (workspace_id, id)`
    // carries no `if not exists`. A retried or partially-completed rollout
    // cannot simply be re-run.
    const db = await applyStack()
    try {
      await expect(
        db.exec(read('20260902043000_domain_integration_review_fixes.sql'))
      ).rejects.toThrow(/already exists/i)
    } finally {
      await db.close()
    }
  })

  it('the first three ARE idempotent', async () => {
    const db = await applyStack(3)
    try {
      for (const name of STACK.slice(0, 3)) {
        await expect(db.exec(read(`${name}.sql`))).resolves.not.toThrow()
      }
    } finally {
      await db.close()
    }
  })

  it('creates no rows: the stack is schema-only', async () => {
    const db = await applyStack()
    try {
      for (const t of [
        'business_entities',
        'business_entity_relations',
        'domain_source_connections',
        'domain_sync_cursors',
        'domain_entity_observation_state',
        'domain_change_source_snapshots',
        'workspace_events',
      ]) {
        const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from public.${t}`)
        expect(rows[0].n, t).toBe(0)
      }
    } finally {
      await db.close()
    }
  })
})
