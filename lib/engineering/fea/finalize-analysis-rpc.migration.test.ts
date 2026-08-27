import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * Exercises caye_finalize_engineering_analysis against a real embedded
 * Postgres, the same way lib/engineering/fea/analysis.ts does, mirroring
 * lib/engineering/finalize-artifact-rpc.migration.test.ts's approach for
 * caye_finalize_engineering_artifact. This RPC deliberately avoids that
 * function's known bug class (a bare column reference colliding with a
 * RETURNS TABLE OUT parameter — see 20260827b_fix_engineering_finalize_
 * ambiguous_revision.sql) by naming its OUT parameter `out_analysis_id`
 * and qualifying every column reference; this test is the regression
 * backstop for that discipline holding, not just a shape check.
 */
describe('caye_finalize_engineering_analysis (PGlite)', () => {
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
    for (const file of ['20260827_engineering_runtime_v1.sql', '20260827b_fix_engineering_finalize_ambiguous_revision.sql', '20260827c_engineering_analysis_v1.sql']) {
      await db.exec(readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'migrations', file), 'utf8'))
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
  /** Creates revision 1 when parent is null, or the next revision in the same lineage otherwise — a real chain, not independent lineages, so "revision reuse" exercises the actual production shape. */
  async function makeArtifact(workspaceId: string, threadId: string, parameters: object, parent?: { id: string; lineageId: string }): Promise<{ id: string; revision: number; lineageId: string }> {
    const artifactJob = await db.query<{ id: string }>(
      `insert into public.engineering_jobs (workspace_id, originating_thread_id, status, task_type, parameters, assumptions)
       values ($1, $2, 'running', $3, $4::jsonb, '[]'::jsonb) returning id`,
      [workspaceId, threadId, parent ? 'revise_parametric_part' : 'create_parametric_part', JSON.stringify(parameters)]
    )
    const artifactId = crypto.randomUUID()
    const lineageId = parent?.lineageId ?? crypto.randomUUID()
    const files = JSON.stringify([
      { kind: 'source', storage_path: 's', media_type: 'text/x-python', byte_size: 10, checksum: 'a' },
      { kind: 'preview_geometry', storage_path: 'p', media_type: 'application/sla', byte_size: 10, checksum: 'b' },
      { kind: 'export_geometry', storage_path: 'e', media_type: 'model/step', byte_size: 10, checksum: 'c' },
      { kind: 'metadata', storage_path: 'm', media_type: 'application/json', byte_size: 10, checksum: 'd' },
    ])
    const { rows } = await db.query<{ artifact_id: string; revision: number }>(
      `select * from public.caye_finalize_engineering_artifact($1,$2,$3,$4,$5,'wall_bracket',$6::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$7::jsonb)`,
      [artifactJob.rows[0].id, workspaceId, artifactId, lineageId, parent?.id ?? null, JSON.stringify(parameters), files]
    )
    return { id: artifactId, revision: rows[0].revision, lineageId }
  }
  async function makeAnalysisJob(workspaceId: string, threadId: string, sourceArtifactId: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.engineering_analysis_jobs (workspace_id, originating_thread_id, status, source_artifact_id, material_id, analysis_spec)
       values ($1, $2, 'running', $3, '6061-t6-aluminum', '{}'::jsonb) returning id`,
      [workspaceId, threadId, sourceArtifactId]
    )
    return rows[0].id
  }
  const files = JSON.stringify([
    { kind: 'solver_input', storage_path: 'i', media_type: 'text/plain', byte_size: 10, checksum: 'a' },
    { kind: 'mesh', storage_path: 'me', media_type: 'application/octet-stream', byte_size: 10, checksum: 'b' },
    { kind: 'solver_output', storage_path: 'o', media_type: 'application/octet-stream', byte_size: 10, checksum: 'c' },
    { kind: 'result_summary', storage_path: 'r', media_type: 'application/json', byte_size: 10, checksum: 'd' },
  ])
  const material = { id: '6061-t6-aluminum', displayName: '6061-T6 Aluminum' }
  const constraints = [{ type: 'fixed', region: 'rear_mounting_face' }]
  const loads = [{ type: 'force', region: 'far_edge', magnitude_n: 300, direction: [0, 0, -1] }]
  const results = { max_von_mises_mpa: 42.5, max_displacement_mm: 0.31, factor_of_safety: 276 / 42.5 }
  const mesh = { nodeCount: 5000, elementCount: 2200, elementType: 'C3D10' }

  async function finalize(args: { jobId: string; workspaceId: string; analysisId: string; sourceArtifactId: string; revision: number; previousAnalysisId?: string | null }) {
    return db.query<{ out_analysis_id: string }>(
      `select * from public.caye_finalize_engineering_analysis($1,$2,$3,$4,$5,'6061-t6-aluminum',$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,'calculix',null,'{}'::jsonb,$11,$12::jsonb)`,
      [args.jobId, args.workspaceId, args.analysisId, args.sourceArtifactId, args.revision, JSON.stringify(material), JSON.stringify(constraints), JSON.stringify(loads), JSON.stringify(mesh), JSON.stringify(results), args.previousAnalysisId ?? null, files]
    )
  }

  it('finalizes an analysis and rejects a job double-finalizing to a different analysis', async () => {
    const workspaceId = await makeWorkspace()
    const threadId = await makeThread()
    const artifact = await makeArtifact(workspaceId, threadId, { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5 })

    const jobId = await makeAnalysisJob(workspaceId, threadId, artifact.id)
    const analysisId = crypto.randomUUID()
    const finalized = await finalize({ jobId, workspaceId, analysisId, sourceArtifactId: artifact.id, revision: artifact.revision })
    expect(finalized.rows[0]).toEqual({ out_analysis_id: analysisId })

    const { rows: jobs } = await db.query<{ status: string }>(`select status from public.engineering_analysis_jobs where id = $1`, [jobId])
    expect(jobs[0].status).toBe('completed')

    const { rows: analyses } = await db.query<{ id: string; source_artifact_revision: number; material_id: string }>(
      `select id, source_artifact_revision, material_id from public.engineering_analyses where id = $1`,
      [analysisId]
    )
    expect(analyses[0]).toMatchObject({ id: analysisId, source_artifact_revision: 1, material_id: '6061-t6-aluminum' })

    // A job may finalize at most one analysis.
    await expect(finalize({ jobId, workspaceId, analysisId: crypto.randomUUID(), sourceArtifactId: artifact.id, revision: artifact.revision })).rejects.toThrow(/already finalized with a different analysis/)
  })

  it('is idempotent on an exact retry of an already-committed analysis', async () => {
    const workspaceId = await makeWorkspace()
    const threadId = await makeThread()
    const artifact = await makeArtifact(workspaceId, threadId, { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5 })
    const jobId = await makeAnalysisJob(workspaceId, threadId, artifact.id)
    const analysisId = crypto.randomUUID()

    await finalize({ jobId, workspaceId, analysisId, sourceArtifactId: artifact.id, revision: artifact.revision })
    const retried = await finalize({ jobId, workspaceId, analysisId, sourceArtifactId: artifact.id, revision: artifact.revision })
    expect(retried.rows[0]).toEqual({ out_analysis_id: analysisId })

    const { rows: analyses } = await db.query(`select count(*)::int as n from public.engineering_analyses where id = $1`, [analysisId])
    expect((analyses[0] as { n: number }).n).toBe(1)
  })

  it('rejects a retry whose payload conflicts with the already-committed analysis', async () => {
    const workspaceId = await makeWorkspace()
    const threadId = await makeThread()
    const artifact = await makeArtifact(workspaceId, threadId, { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5 })
    const jobId = await makeAnalysisJob(workspaceId, threadId, artifact.id)
    const analysisId = crypto.randomUUID()
    await finalize({ jobId, workspaceId, analysisId, sourceArtifactId: artifact.id, revision: artifact.revision })

    await expect(
      db.query(
        `select * from public.caye_finalize_engineering_analysis($1,$2,$3,$4,$5,'6061-t6-aluminum',$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,'calculix',null,'{}'::jsonb,null,$11::jsonb)`,
        [jobId, workspaceId, analysisId, artifact.id, artifact.revision, JSON.stringify(material), JSON.stringify(constraints), JSON.stringify(loads), JSON.stringify(mesh), JSON.stringify({ ...results, max_von_mises_mpa: 999 }), files]
      )
    ).rejects.toThrow(/conflicts with committed analysis/)
  })

  it('revision reuse: the same explicit spec run against two revisions of the SAME lineage (thickness 5mm then 4mm) produces two distinct, independently correct analyses', async () => {
    const workspaceId = await makeWorkspace()
    const threadId = await makeThread()
    const artifactRev1 = await makeArtifact(workspaceId, threadId, { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5 })
    const artifactRev2 = await makeArtifact(workspaceId, threadId, { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 4 }, { id: artifactRev1.id, lineageId: artifactRev1.lineageId })
    expect(artifactRev1.revision).toBe(1)
    expect(artifactRev2.revision).toBe(2)

    const job1 = await makeAnalysisJob(workspaceId, threadId, artifactRev1.id)
    const analysis1Id = crypto.randomUUID()
    await finalize({ jobId: job1, workspaceId, analysisId: analysis1Id, sourceArtifactId: artifactRev1.id, revision: artifactRev1.revision })

    const job2 = await makeAnalysisJob(workspaceId, threadId, artifactRev2.id)
    const analysis2Id = crypto.randomUUID()
    await finalize({ jobId: job2, workspaceId, analysisId: analysis2Id, sourceArtifactId: artifactRev2.id, revision: artifactRev2.revision, previousAnalysisId: analysis1Id })

    const { rows: analyses } = await db.query<{ id: string; source_artifact_id: string; source_artifact_revision: number; previous_analysis_id: string | null }>(
      `select id, source_artifact_id, source_artifact_revision, previous_analysis_id from public.engineering_analyses where workspace_id = $1 order by created_at`,
      [workspaceId]
    )
    expect(analyses).toHaveLength(2)
    expect(analyses[0]).toMatchObject({ id: analysis1Id, source_artifact_id: artifactRev1.id, source_artifact_revision: 1, previous_analysis_id: null })
    expect(analyses[1]).toMatchObject({ id: analysis2Id, source_artifact_id: artifactRev2.id, source_artifact_revision: 2, previous_analysis_id: analysis1Id })

    // The prior analysis is untouched by the rerun.
    const { rows: prior } = await db.query(`select source_artifact_revision from public.engineering_analyses where id = $1`, [analysis1Id])
    expect((prior[0] as { source_artifact_revision: number }).source_artifact_revision).toBe(1)
  })

  it('requires exactly four files with the required kinds', async () => {
    const workspaceId = await makeWorkspace()
    const threadId = await makeThread()
    const artifact = await makeArtifact(workspaceId, threadId, { width_mm: 120, height_mm: 80, depth_mm: 40, thickness_mm: 5 })
    const jobId = await makeAnalysisJob(workspaceId, threadId, artifact.id)
    await expect(
      db.query(
        `select * from public.caye_finalize_engineering_analysis($1,$2,$3,$4,$5,'6061-t6-aluminum',$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,'calculix',null,'{}'::jsonb,null,'[]'::jsonb)`,
        [jobId, workspaceId, crypto.randomUUID(), artifact.id, artifact.revision, JSON.stringify(material), JSON.stringify(constraints), JSON.stringify(loads), JSON.stringify(mesh), JSON.stringify(results)]
      )
    ).rejects.toThrow(/exactly four files/)
  })
})
