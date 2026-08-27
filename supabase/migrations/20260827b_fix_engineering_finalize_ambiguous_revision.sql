-- Fixes a production bug in caye_finalize_engineering_artifact (20260827_
-- engineering_runtime_v1.sql): every revise_parametric_part call failed
-- with "column reference \"revision\" is ambiguous". The function's
-- `returns table (artifact_id uuid, revision integer)` implicitly declares
-- `revision` as a PL/pgSQL OUT-parameter variable in scope for the whole
-- function body. The stale-parent guard's `select max(revision) from
-- engineering_artifacts ...` bare column reference collided with that
-- variable under Postgres's default plpgsql.variable_conflict = error,
-- so Postgres refused to pick one and raised inside the transaction —
-- rolling back cleanly (no partial artifact, confirmed via production
-- engineering_jobs.failure_reason and an unchanged engineering_artifacts
-- table) but leaving every revision permanently unable to complete.
-- create_parametric_part never hit this: p_parent_artifact_id is null on
-- first creation, so the branch containing the ambiguous subquery never
-- ran.
--
-- Fix: qualify the column with its table name. No other behavior change.
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
  v_existing engineering_artifacts%rowtype;
  v_revision integer;
  v_file jsonb;
  v_count integer;
  v_kind_count integer;
  v_existing_file engineering_artifact_files%rowtype;
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

  -- Reconciliation/idempotency path. If this artifact/job already committed,
  -- only an exact semantic retry is accepted.
  select * into v_existing from engineering_artifacts
    where id = p_artifact_id and job_id = p_job_id and workspace_id = p_workspace_id;
  if found then
    if v_existing.lineage_id <> p_lineage_id
      or v_existing.parent_artifact_id is distinct from p_parent_artifact_id
      or v_existing.name <> p_name
      or v_existing.parameters <> p_parameters
      or v_existing.assumptions <> p_assumptions
      or v_existing.dimensions <> p_dimensions
      or v_existing.calculation_metadata <> p_calculation_metadata then
      raise exception 'engineering finalization retry conflicts with committed artifact';
    end if;
    if not exists (select 1 from engineering_jobs where id = p_job_id and workspace_id = p_workspace_id and status = 'completed') then
      raise exception 'committed engineering artifact has inconsistent job state';
    end if;
    for v_file in select value from jsonb_array_elements(p_files) loop
      select * into v_existing_file from engineering_artifact_files
        where artifact_id = p_artifact_id and kind = v_file->>'kind';
      if not found
        or v_existing_file.storage_path <> v_file->>'storage_path'
        or v_existing_file.media_type <> v_file->>'media_type'
        or v_existing_file.byte_size <> (v_file->>'byte_size')::integer
        or v_existing_file.checksum <> v_file->>'checksum' then
        raise exception 'engineering finalization retry conflicts with committed file metadata';
      end if;
    end loop;
    return query select p_artifact_id, v_existing.revision;
    return;
  end if;

  -- A job may finalize at most one artifact. This catches a retry that changes
  -- artifact id rather than silently producing another revision.
  if exists (select 1 from engineering_artifacts where job_id = p_job_id) then
    raise exception 'engineering job was already finalized with a different artifact';
  end if;

  if p_parent_artifact_id is null then
    v_revision := 1;
  else
    select * into v_parent from engineering_artifacts
      where id = p_parent_artifact_id and workspace_id = p_workspace_id and lineage_id = p_lineage_id
      for update;
    if not found then raise exception 'engineering revision parent is not in this lineage'; end if;
    -- Column qualified (engineering_artifacts.revision) — see this
    -- migration's header comment for why the bare form was ambiguous.
    if v_parent.revision <> (select max(engineering_artifacts.revision) from engineering_artifacts where workspace_id = p_workspace_id and lineage_id = p_lineage_id) then
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
