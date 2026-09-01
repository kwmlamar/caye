-- Phase 1 follow-up: derived records with a deterministic persisted parent must
-- bind to that parent's semantic provenance. This prevents privileged callers
-- from bypassing monotonic derivation by omitting parent_provenance_id.

create or replace function public.caye_semantic_record_parent(
  p_record_table text,
  p_record_id text
)
returns table(parent_record_table text, parent_record_id text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  case p_record_table
    when 'business_artifacts' then
      return query
      select
        case
          when unified_message_id is not null then 'unified_messages'::text
          when operator_message_id is not null then 'caye_operator_messages'::text
          else null::text
        end,
        coalesce(unified_message_id::text, operator_message_id::text)
      from public.business_artifacts
      where id::text = p_record_id
        and (unified_message_id is not null or operator_message_id is not null);

    when 'business_artifact_observations' then
      return query
      select 'business_artifacts'::text, artifact_id::text
      from public.business_artifact_observations
      where id::text = p_record_id;

    when 'business_learning_observations' then
      return query
      select
        case
          when unified_message_id is not null then 'unified_messages'::text
          when operator_message_id is not null then 'caye_operator_messages'::text
          else null::text
        end,
        coalesce(unified_message_id::text, operator_message_id::text)
      from public.business_learning_observations
      where id::text = p_record_id
        and (unified_message_id is not null or operator_message_id is not null);

    when 'business_fact_candidates' then
      return query
      select 'business_learning_observations'::text, observation_id::text
      from public.business_fact_candidates
      where id::text = p_record_id
        and observation_id is not null;

    when 'caye_work_opportunity_evidence' then
      return query
      select
        case
          when lower(coalesce(source_type, '')) in ('unified_message','unified_messages') then 'unified_messages'::text
          when lower(coalesce(source_type, '')) in ('operator_message','caye_operator_messages') then 'caye_operator_messages'::text
          when lower(coalesce(source_type, '')) in ('business_artifact','business_artifacts') then 'business_artifacts'::text
          when lower(coalesce(source_type, '')) in ('business_learning_observation','business_learning_observations') then 'business_learning_observations'::text
          else null::text
        end,
        source_id
      from public.caye_work_opportunity_evidence
      where id::text = p_record_id
        and source_id is not null
        and lower(coalesce(source_type, '')) in (
          'unified_message','unified_messages',
          'operator_message','caye_operator_messages',
          'business_artifact','business_artifacts',
          'business_learning_observation','business_learning_observations'
        );

    when 'engineering_artifacts' then
      return query
      select 'engineering_artifacts'::text, parent_artifact_id::text
      from public.engineering_artifacts
      where id::text = p_record_id
        and parent_artifact_id is not null;

    else
      return;
  end case;
end;
$$;

create or replace function public.caye_enforce_semantic_provenance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent public.semantic_provenance%rowtype;
  v_record_workspace uuid;
  v_expected_parent_table text;
  v_expected_parent_id text;
begin
  if not public.caye_is_valid_semantic_scope(new.semantic_scope) then
    raise exception 'invalid semantic scope: %', new.semantic_scope;
  end if;

  v_record_workspace := public.caye_semantic_record_workspace(new.record_table, new.record_id);
  if v_record_workspace is null then
    raise exception 'semantic provenance source record %.% does not exist or has no workspace', new.record_table, new.record_id;
  end if;
  if v_record_workspace <> new.workspace_id then
    raise exception 'semantic provenance workspace mismatch for %.%: record %, provenance %',
      new.record_table, new.record_id, v_record_workspace, new.workspace_id;
  end if;

  select p.parent_record_table, p.parent_record_id
  into v_expected_parent_table, v_expected_parent_id
  from public.caye_semantic_record_parent(new.record_table, new.record_id) p
  limit 1;

  if v_expected_parent_id is not null and new.parent_provenance_id is null then
    raise exception 'semantic provenance for derived record %.% requires parent %.%',
      new.record_table, new.record_id, v_expected_parent_table, v_expected_parent_id;
  end if;

  if new.parent_provenance_id is not null then
    select * into v_parent
    from public.semantic_provenance
    where id = new.parent_provenance_id;

    if not found then
      raise exception 'semantic provenance parent % does not exist', new.parent_provenance_id;
    end if;
    if v_parent.workspace_id <> new.workspace_id then
      raise exception 'semantic scope derivation cannot cross workspaces';
    end if;
    if v_expected_parent_id is not null
      and (v_parent.record_table <> v_expected_parent_table or v_parent.record_id <> v_expected_parent_id) then
      raise exception 'semantic provenance parent mismatch for %.%: expected %.%, got %.%',
        new.record_table, new.record_id,
        v_expected_parent_table, v_expected_parent_id,
        v_parent.record_table, v_parent.record_id;
    end if;
    if not public.caye_can_derive_semantic_scope(v_parent.semantic_scope, new.semantic_scope) then
      raise exception 'semantic scope cannot widen from % to %', v_parent.semantic_scope, new.semantic_scope;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- Rebind the trigger explicitly so reruns are deterministic even if an older
-- migration version installed the previous function definition.
drop trigger if exists trg_caye_enforce_semantic_provenance on public.semantic_provenance;
create trigger trg_caye_enforce_semantic_provenance
before insert or update of workspace_id, record_table, record_id, semantic_scope, parent_provenance_id
on public.semantic_provenance
for each row execute function public.caye_enforce_semantic_provenance();
