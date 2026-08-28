-- CAY-25 defense in depth for provenance/evidence references.
-- Existing business_artifacts and caye_operator_messages use globally unique
-- primary keys but do not expose composite (workspace_id,id) keys suitable for
-- a declarative composite FK. Keep those established tables untouched and make
-- the new property tables enforce same-workspace evidence via triggers instead.

create or replace function public.caye_assert_property_observation_source_scope()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.source_artifact_id is not null and not exists (
    select 1
    from public.business_artifacts a
    where a.id = new.source_artifact_id
      and a.workspace_id = new.workspace_id
  ) then
    raise exception 'property observation source artifact is not in this workspace';
  end if;

  if new.source_message_id is not null and not exists (
    select 1
    from public.caye_operator_messages m
    where m.id = new.source_message_id
      and m.workspace_id = new.workspace_id
  ) then
    raise exception 'property observation source message is not in this workspace';
  end if;

  return new;
end;
$$;

revoke all on function public.caye_assert_property_observation_source_scope() from public, anon, authenticated;

drop trigger if exists property_observation_source_scope_guard on public.property_observations;
create trigger property_observation_source_scope_guard
before insert or update of workspace_id, source_artifact_id, source_message_id
on public.property_observations
for each row execute function public.caye_assert_property_observation_source_scope();

create or replace function public.caye_assert_property_artifact_scope()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.business_artifacts a
    where a.id = new.artifact_id
      and a.workspace_id = new.workspace_id
  ) then
    raise exception 'property artifact evidence is not in this workspace';
  end if;

  return new;
end;
$$;

revoke all on function public.caye_assert_property_artifact_scope() from public, anon, authenticated;

drop trigger if exists property_artifact_scope_guard on public.property_artifact_links;
create trigger property_artifact_scope_guard
before insert or update of workspace_id, artifact_id
on public.property_artifact_links
for each row execute function public.caye_assert_property_artifact_scope();
