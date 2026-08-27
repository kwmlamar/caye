import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * Reproduces the 2026-08-27 production incident against a real embedded
 * Postgres: the very first "make it 20% thinner" revision after a
 * successful initial CAD generation failed every time with
 * `column reference "revision" is ambiguous`, confirmed live via
 * engineering_jobs.failure_reason (task_type=revise_parametric_part).
 *
 * Root cause: caye_finalize_engineering_artifact's `returns table
 * (artifact_id uuid, revision integer)` implicitly declares `revision` as
 * a PL/pgSQL variable in scope for the whole function body. The
 * stale-parent guard's `select max(revision) from engineering_artifacts`
 * bare column reference collided with it under Postgres's default
 * plpgsql.variable_conflict = error. create_parametric_part never hit
 * this because p_parent_artifact_id is null on first creation, so the
 * branch containing the ambiguous subquery never ran — only revisions did.
 *
 * 20260827b_fix_engineering_finalize_ambiguous_revision.sql qualifies the
 * column. This test applies both migrations in the real deployment order
 * and exercises the RPC directly, the same way lib/engineering/artifacts.ts
 * does, so a regression here fails loudly instead of silently reverting to
 * the incident.
 */
describe('caye_finalize_engineering_artifact revision path (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create schema if not exists storage;
      create table storage.buckets (
        id text primary key,
        name text not null,
        public boolean not null default false,
        file_size_limit bigint,
        allowed_mime_types text[]
      );
      create table public.customers (id uuid primary key default gen_random_uuid());
      create table public.caye_direct_threads (id uuid primary key default gen_random_uuid());
      create table public.caye_operator_messages (id uuid primary key default gen_random_uuid());

      do $$
      begin
        if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end
      $$;
    `)
    for (const file of ['20260827_engineering_runtime_v1.sql', '20260827b_fix_engineering_finalize_ambiguous_revision.sql']) {
      await db.exec(readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', file), 'utf8'))
    }
  })

  afterAll(async () => { await db.close() })

  async function makeWorkspace(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(`insert into public.customers default values returning id`)
    return rows[0].id
  }
  async function makeThread(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(`insert into public.caye_direct_threads default values returning id`)
    return rows[0].id
  }
  async function makeJob(workspaceId: string, threadId: string, taskType: 'create_parametric_part' | 'revise_parametric_part'): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.engineering_jobs (workspace_id, originating_thread_id, status, task_type, parameters, assumptions)
       values ($1, $2, 'running', $3, '{}'::jsonb, '[]'::jsonb) returning id`,
      [workspaceId, threadId, taskType]
    )
    return rows[0].id
  }
  const files = JSON.stringify([
    { kind: 'source', storage_path: 's', media_type: 'text/x-python', byte_size: 10, checksum: 'a' },
    { kind: 'preview_geometry', storage_path: 'p', media_type: 'application/sla', byte_size: 10, checksum: 'b' },
    { kind: 'export_geometry', storage_path: 'e', media_type: 'model/step', byte_size: 10, checksum: 'c' },
    { kind: 'metadata', storage_path: 'm', media_type: 'application/json', byte_size: 10, checksum: 'd' },
  ])
  async function finalize(args: { jobId: string; workspaceId: string; artifactId: string; lineageId: string; parentArtifactId: string | null; parameters: object }) {
    return db.query<{ artifact_id: string; revision: number }>(
      `select * from public.caye_finalize_engineering_artifact($1,$2,$3,$4,$5,'wall_bracket',$6,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$7::jsonb)`,
      [args.jobId, args.workspaceId, args.artifactId, args.lineageId, args.parentArtifactId, JSON.stringify(args.parameters), files]
    )
  }

  it('creates revision 1, then successfully revises to revision 2 in the same lineage (production regression)', async () => {
    const workspaceId = await makeWorkspace()
    const threadId = await makeThread()
    const lineageId = crypto.randomUUID()

    const job1 = await makeJob(workspaceId, threadId, 'create_parametric_part')
    const artifact1Id = crypto.randomUUID()
    const initialParameters = { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5, mounting_hole_diameter_mm: 6, mounting_hole_count: 4 }
    const rev1 = await finalize({ jobId: job1, workspaceId, artifactId: artifact1Id, lineageId, parentArtifactId: null, parameters: initialParameters })
    expect(rev1.rows[0]).toEqual({ artifact_id: artifact1Id, revision: 1 })

    // "Make it 20% thinner": only thickness_mm changes, everything else preserved.
    const job2 = await makeJob(workspaceId, threadId, 'revise_parametric_part')
    const artifact2Id = crypto.randomUUID()
    const revisedParameters = { ...initialParameters, thickness_mm: 4 }
    const rev2 = await finalize({ jobId: job2, workspaceId, artifactId: artifact2Id, lineageId, parentArtifactId: artifact1Id, parameters: revisedParameters })
    expect(rev2.rows[0]).toEqual({ artifact_id: artifact2Id, revision: 2 })

    const { rows: artifacts } = await db.query<{ id: string; revision: number; lineage_id: string; parent_artifact_id: string | null; parameters: { thickness_mm: number; width_mm: number; height_mm: number; depth_mm: number; mounting_hole_diameter_mm: number } }>(
      `select id, revision, lineage_id, parent_artifact_id, parameters from public.engineering_artifacts where workspace_id = $1 order by revision`,
      [workspaceId]
    )
    expect(artifacts).toHaveLength(2)
    expect(artifacts[0]).toMatchObject({ id: artifact1Id, revision: 1, lineage_id: lineageId, parent_artifact_id: null })
    expect(artifacts[0].parameters).toEqual(initialParameters) // revision 1 remains unchanged
    expect(artifacts[1]).toMatchObject({ id: artifact2Id, revision: 2, lineage_id: lineageId, parent_artifact_id: artifact1Id })
    expect(artifacts[1].parameters).toEqual(revisedParameters)
    expect(artifacts[1].parameters.thickness_mm).toBe(4)
    expect(artifacts[1].parameters.width_mm).toBe(120)
    expect(artifacts[1].parameters.height_mm).toBe(80)
    expect(artifacts[1].parameters.depth_mm).toBe(40)
    expect(artifacts[1].parameters.mounting_hole_diameter_mm).toBe(6)

    const { rows: jobs } = await db.query<{ status: string }>(`select status from public.engineering_jobs where id = any($1)`, [[job1, job2]])
    expect(jobs.every((j) => j.status === 'completed')).toBe(true)

    // Stale-parent guard must still reject a second revision built against
    // the now-superseded revision 1 (unrelated concurrent-revision protection).
    const job3 = await makeJob(workspaceId, threadId, 'revise_parametric_part')
    await expect(
      finalize({ jobId: job3, workspaceId, artifactId: crypto.randomUUID(), lineageId, parentArtifactId: artifact1Id, parameters: { ...initialParameters, thickness_mm: 3 } })
    ).rejects.toThrow(/no longer current/)
  })
})
