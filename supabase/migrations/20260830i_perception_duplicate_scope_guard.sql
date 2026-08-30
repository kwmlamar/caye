-- Perception telemetry duplicate-scope guard
--
-- The original raw telemetry table intentionally dedupes on (provider, provider_event_id).
-- TTN-generated ids normally include application/device identity, but tenant isolation should
-- not depend on a provider continuing to honor that convention forever.
--
-- Serialize equal provider event identities before insert, then reject a collision if the
-- already-retained raw event belongs to a different registered device/workspace. Same-device
-- retries are allowed through so the existing unique constraint drives the ingest RPC's
-- idempotent duplicate path.

create or replace function public.caye_guard_property_telemetry_event_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing_device_id uuid;
  v_existing_workspace_id uuid;
begin
  -- Transaction-scoped advisory lock closes the race where two devices submit the same
  -- provider event identity concurrently and neither can see the other's uncommitted row.
  perform pg_advisory_xact_lock(
    hashtextextended(new.provider || E'\x1f' || new.provider_event_id, 0)
  );

  select device_id, workspace_id
    into v_existing_device_id, v_existing_workspace_id
  from public.property_telemetry_events
  where provider = new.provider
    and provider_event_id = new.provider_event_id
  limit 1;

  if found and (
    v_existing_device_id is distinct from new.device_id
    or v_existing_workspace_id is distinct from new.workspace_id
  ) then
    raise exception 'Telemetry provider event identity collides across registered source scope'
      using errcode = '22000';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_caye_property_telemetry_event_scope_guard
  on public.property_telemetry_events;
create trigger trg_caye_property_telemetry_event_scope_guard
  before insert on public.property_telemetry_events
  for each row execute function public.caye_guard_property_telemetry_event_scope();

revoke execute on function public.caye_guard_property_telemetry_event_scope()
  from public, anon, authenticated;

grant execute on function public.caye_guard_property_telemetry_event_scope()
  to service_role;

comment on function public.caye_guard_property_telemetry_event_scope() is
  'Fail-closed tenant/source guard for globally deduplicated provider telemetry event identities; serializes concurrent collisions before insert.';
