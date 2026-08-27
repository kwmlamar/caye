-- Founder-only engineering work. Binaries live in the private
-- engineering-artifacts Storage bucket, never in Postgres.
create table if not exists public.engineering_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  originating_thread_id uuid not null references public.caye_direct_threads(id) on delete restrict,
  originating_message_id uuid references public.caye_operator_messages(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  task_type text not null check (task_type in ('create_parametric_part','revise_parametric_part')),
  parameters jsonb not null,
  assumptions jsonb not null default '[]'::jsonb,
  runtime text not null default 'cadquery',
  provenance jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now()
);
create index if not exists engineering_jobs_workspace_thread_idx on public.engineering_jobs(workspace_id, originating_thread_id, created_at desc);

create table if not exists public.engineering_artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  job_id uuid not null references public.engineering_jobs(id) on delete restrict,
  -- A lineage is identity; name is only mutable/display metadata.
  lineage_id uuid not null,
  parent_artifact_id uuid references public.engineering_artifacts(id) on delete restrict,
  revision integer not null check (revision > 0),
  name text not null,
  parameters jsonb not null,
  assumptions jsonb not null default '[]'::jsonb,
  dimensions jsonb not null default '{}'::jsonb,
  calculation_metadata jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, lineage_id, revision)
);
create index if not exists engineering_artifacts_workspace_idx on public.engineering_artifacts(workspace_id, lineage_id, created_at desc);

create table if not exists public.engineering_artifact_files (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.engineering_artifacts(id) on delete cascade,
  kind text not null check (kind in ('source','preview_geometry','export_geometry','metadata')),
  storage_path text not null,
  media_type text not null,
  byte_size integer not null check (byte_size >= 0 and byte_size <= 26214400),
  checksum text not null,
  created_at timestamptz not null default now(),
  unique (artifact_id, kind)
);

alter table public.engineering_jobs enable row level security;
alter table public.engineering_artifacts enable row level security;
alter table public.engineering_artifact_files enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('engineering-artifacts', 'engineering-artifacts', false, 26214400,
  array['text/x-python','application/sla','model/step','application/json'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Only server routes use the service role for this V1; no browser policy grants
-- raw object access. Signed URLs are minted after a founder + workspace check.

-- The database half of finalization is one transaction: a row cannot be
-- discovered unless all four metadata rows exist and the job is completed.
create or replace function public.caye_finalize_engineering_artifact(
  p_job_id uuid,
  p_workspace_id uuid,
  p_artifact_id uuid,
  p_lineage_id uuid,
  p_parent_artifact_id uuid,
  p_name text,
  p_parameters jsonb,
  p_assumptions jsonb,
  p_dimensions jsonb,
  p_calculation_metadata jsonb,
  p_provenance jsonb,
  p_files jsonb
) returns table (artifact_id uuid, revision integer)
language plpgsql security definer set search_path = public as $$
declare
  v_parent engineering_artifacts%rowtype;
  v_revision integer;
  v_file jsonb;
  v_count integer;
  v_kind_count integer;
begin
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) <> 4 then
    raise exception 'engineering artifact must have exactly four files';
  end if;
  select count(*), count(distinct value->>'kind') into v_count, v_kind_count
    from jsonb_array_elements(p_files);
  if v_count <> 4 or v_kind_count <> 4 or not (p_files @> '[{"kind":"source"},{"kind":"preview_geometry"},{"kind":"export_geometry"},{"kind":"metadata"}]'::jsonb) then
    raise exception 'engineering artifact is missing a required file kind';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_lineage_id::text, 0));
  if p_parent_artifact_id is null then
    v_revision := 1;
  else
    select * into v_parent from engineering_artifacts
      where id = p_parent_artifact_id and workspace_id = p_workspace_id and lineage_id = p_lineage_id
      for update;
    if not found then raise exception 'engineering revision parent is not in this lineage'; end if;
    if v_parent.revision <> (select max(revision) from engineering_artifacts where workspace_id = p_workspace_id and lineage_id = p_lineage_id) then
      raise exception 'engineering revision parent is no longer current';
    end if;
    v_revision := v_parent.revision + 1;
  end if;
  update engineering_jobs set status = 'completed', completed_at = now()
    where id = p_job_id and workspace_id = p_workspace_id and status = 'running';
  if not found then raise exception 'engineering job is not running'; end if;
  insert into engineering_artifacts (id, workspace_id, job_id, lineage_id, parent_artifact_id, revision, name, parameters, assumptions, dimensions, calculation_metadata, provenance)
    values (p_artifact_id, p_workspace_id, p_job_id, p_lineage_id, p_parent_artifact_id, v_revision, p_name, p_parameters, p_assumptions, p_dimensions, p_calculation_metadata, p_provenance);
  for v_file in select value from jsonb_array_elements(p_files) loop
    if coalesce(v_file->>'storage_path', '') = '' or coalesce(v_file->>'media_type', '') = '' or coalesce(v_file->>'checksum', '') = '' or coalesce((v_file->>'byte_size')::integer, 0) < 1 then
      raise exception 'invalid engineering artifact file';
    end if;
    insert into engineering_artifact_files (artifact_id, kind, storage_path, media_type, byte_size, checksum)
      values (p_artifact_id, v_file->>'kind', v_file->>'storage_path', v_file->>'media_type', (v_file->>'byte_size')::integer, v_file->>'checksum');
  end loop;
  return query select p_artifact_id, v_revision;
end;
$$;
revoke all on function public.caye_finalize_engineering_artifact(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.caye_finalize_engineering_artifact(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;
