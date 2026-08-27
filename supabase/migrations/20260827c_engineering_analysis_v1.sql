-- FEA V1: static linear structural analysis on top of an existing
-- engineering_artifacts revision. Same job -> stage -> atomic-finalize
-- shape as 20260827_engineering_runtime_v1.sql; binaries live in the
-- private engineering-analyses Storage bucket, never in Postgres.
--
-- Column-ambiguity note: 20260827b_fix_engineering_finalize_ambiguous_
-- revision.sql fixed a production incident where
-- caye_finalize_engineering_artifact's `returns table (..., revision
-- integer)` implicitly declared `revision` as a PL/pgSQL variable, which
-- collided with a bare `revision` column reference in a subquery. This
-- migration avoids that whole bug class structurally: the RPC below names
-- its OUT parameter `out_analysis_id` (never `id` or any column name used
-- bare elsewhere), and every column reference in the function body is
-- table-qualified regardless.

create table if not exists public.engineering_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  originating_thread_id uuid not null references public.caye_direct_threads(id) on delete restrict,
  originating_message_id uuid references public.caye_operator_messages(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','meshing','solving','completed','failed')),
  source_artifact_id uuid not null references public.engineering_artifacts(id) on delete restrict,
  analysis_type text not null default 'linear_static' check (analysis_type in ('linear_static')),
  material_id text not null,
  analysis_spec jsonb not null,
  solver text not null default 'calculix',
  solver_version text,
  provenance jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now()
);
create index if not exists engineering_analysis_jobs_workspace_thread_idx on public.engineering_analysis_jobs(workspace_id, originating_thread_id, created_at desc);

create table if not exists public.engineering_analyses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  job_id uuid not null unique references public.engineering_analysis_jobs(id) on delete restrict,
  source_artifact_id uuid not null references public.engineering_artifacts(id) on delete restrict,
  source_artifact_revision integer not null check (source_artifact_revision > 0),
  material_id text not null,
  material jsonb not null,
  analysis_type text not null default 'linear_static' check (analysis_type in ('linear_static')),
  constraints jsonb not null,
  loads jsonb not null,
  mesh_metadata jsonb not null,
  results jsonb not null,
  solver text not null,
  solver_version text,
  provenance jsonb not null default '{}'::jsonb,
  -- Lineage/traceability only for "rerun the same test" (dispatch's
  -- revision-reuse case) -- NOT an identity column and no "current
  -- revision" race exists here: each row ties to one immutable artifact
  -- row, never a mutable "latest" pointer, so unlike engineering_artifacts
  -- there is nothing to guard against going stale mid-finalize.
  previous_analysis_id uuid references public.engineering_analyses(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists engineering_analyses_workspace_artifact_idx on public.engineering_analyses(workspace_id, source_artifact_id, created_at desc);

create table if not exists public.engineering_analysis_files (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.engineering_analyses(id) on delete cascade,
  kind text not null check (kind in ('solver_input','mesh','solver_output','result_summary')),
  storage_path text not null,
  media_type text not null,
  byte_size integer not null check (byte_size >= 0 and byte_size <= 26214400),
  checksum text not null,
  created_at timestamptz not null default now(),
  unique (analysis_id, kind)
);

alter table public.engineering_analysis_jobs enable row level security;
alter table public.engineering_analyses enable row level security;
alter table public.engineering_analysis_files enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('engineering-analyses', 'engineering-analyses', false, 26214400,
  array['text/plain','application/octet-stream','application/json'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Only server routes use the service role for this V1; no browser policy
-- grants raw object access. The result_summary is resolved server-side
-- after a founder + workspace check, mirroring caye_finalize_engineering_
-- artifact's trust model exactly.
--
-- No stale-parent guard is needed here (see previous_analysis_id comment
-- above): finalization is a straightforward idempotent-retry-or-insert,
-- one analysis per job.
create or replace function public.caye_finalize_engineering_analysis(
  p_job_id uuid,
  p_workspace_id uuid,
  p_analysis_id uuid,
  p_source_artifact_id uuid,
  p_source_artifact_revision integer,
  p_material_id text,
  p_material jsonb,
  p_constraints jsonb,
  p_loads jsonb,
  p_mesh_metadata jsonb,
  p_results jsonb,
  p_solver text,
  p_solver_version text,
  p_provenance jsonb,
  p_previous_analysis_id uuid,
  p_files jsonb
) returns table (out_analysis_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_existing public.engineering_analyses%rowtype;
  v_file jsonb;
  v_count integer;
  v_kind_count integer;
  v_existing_file public.engineering_analysis_files%rowtype;
begin
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) <> 4 then
    raise exception 'engineering analysis must have exactly four files';
  end if;
  select count(*), count(distinct value->>'kind') into v_count, v_kind_count
    from jsonb_array_elements(p_files);
  if v_count <> 4 or v_kind_count <> 4 or not (p_files @> '[{"kind":"solver_input"},{"kind":"mesh"},{"kind":"solver_output"},{"kind":"result_summary"}]'::jsonb) then
    raise exception 'engineering analysis is missing a required file kind';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_job_id::text, 0));

  -- Idempotent retry path: only an exact semantic match is accepted.
  select * into v_existing from public.engineering_analyses
    where public.engineering_analyses.id = p_analysis_id
      and public.engineering_analyses.job_id = p_job_id
      and public.engineering_analyses.workspace_id = p_workspace_id;
  if found then
    if v_existing.source_artifact_id <> p_source_artifact_id
      or v_existing.source_artifact_revision <> p_source_artifact_revision
      or v_existing.material_id <> p_material_id
      or v_existing.material <> p_material
      or v_existing.constraints <> p_constraints
      or v_existing.loads <> p_loads
      or v_existing.mesh_metadata <> p_mesh_metadata
      or v_existing.results <> p_results
      or v_existing.previous_analysis_id is distinct from p_previous_analysis_id then
      raise exception 'engineering analysis finalization retry conflicts with committed analysis';
    end if;
    if not exists (select 1 from public.engineering_analysis_jobs where public.engineering_analysis_jobs.id = p_job_id and public.engineering_analysis_jobs.workspace_id = p_workspace_id and public.engineering_analysis_jobs.status = 'completed') then
      raise exception 'committed engineering analysis has inconsistent job state';
    end if;
    for v_file in select value from jsonb_array_elements(p_files) loop
      select * into v_existing_file from public.engineering_analysis_files
        where public.engineering_analysis_files.analysis_id = p_analysis_id and public.engineering_analysis_files.kind = v_file->>'kind';
      if not found
        or v_existing_file.storage_path <> v_file->>'storage_path'
        or v_existing_file.media_type <> v_file->>'media_type'
        or v_existing_file.byte_size <> (v_file->>'byte_size')::integer
        or v_existing_file.checksum <> v_file->>'checksum' then
        raise exception 'engineering analysis finalization retry conflicts with committed file metadata';
      end if;
    end loop;
    return query select p_analysis_id;
    return;
  end if;

  -- A job may finalize at most one analysis.
  if exists (select 1 from public.engineering_analyses where public.engineering_analyses.job_id = p_job_id) then
    raise exception 'engineering analysis job was already finalized with a different analysis';
  end if;

  if p_source_artifact_revision is null or p_source_artifact_revision < 1 then
    raise exception 'engineering analysis requires a valid source artifact revision';
  end if;

  update public.engineering_analysis_jobs set status = 'completed', completed_at = now()
    where public.engineering_analysis_jobs.id = p_job_id
      and public.engineering_analysis_jobs.workspace_id = p_workspace_id
      and public.engineering_analysis_jobs.status in ('running','meshing','solving');
  if not found then raise exception 'engineering analysis job is not in a runnable state'; end if;

  insert into public.engineering_analyses (
    id, workspace_id, job_id, source_artifact_id, source_artifact_revision, material_id, material,
    constraints, loads, mesh_metadata, results, solver, solver_version, provenance, previous_analysis_id
  ) values (
    p_analysis_id, p_workspace_id, p_job_id, p_source_artifact_id, p_source_artifact_revision, p_material_id, p_material,
    p_constraints, p_loads, p_mesh_metadata, p_results, p_solver, p_solver_version, p_provenance, p_previous_analysis_id
  );

  for v_file in select value from jsonb_array_elements(p_files) loop
    if coalesce(v_file->>'storage_path', '') = '' or coalesce(v_file->>'media_type', '') = '' or coalesce(v_file->>'checksum', '') = '' or coalesce((v_file->>'byte_size')::integer, 0) < 1 then
      raise exception 'invalid engineering analysis file';
    end if;
    insert into public.engineering_analysis_files (analysis_id, kind, storage_path, media_type, byte_size, checksum)
      values (p_analysis_id, v_file->>'kind', v_file->>'storage_path', v_file->>'media_type', (v_file->>'byte_size')::integer, v_file->>'checksum');
  end loop;
  return query select p_analysis_id;
end;
$$;
revoke all on function public.caye_finalize_engineering_analysis(uuid,uuid,uuid,uuid,integer,text,jsonb,jsonb,jsonb,jsonb,jsonb,text,text,jsonb,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.caye_finalize_engineering_analysis(uuid,uuid,uuid,uuid,integer,text,jsonb,jsonb,jsonb,jsonb,jsonb,text,text,jsonb,uuid,jsonb) to service_role;
