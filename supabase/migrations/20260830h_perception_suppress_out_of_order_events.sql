-- A delayed provider event is still valid source history, but it is not a NEW change in
-- the workspace's current operational state. The perception ingest RPC writes the raw
-- telemetry first and only later updates the monotonic current-state projection. Without
-- this guard, a delayed reading whose fingerprint differs from the current reading could
-- emit a false ordinary_change before the projection trigger correctly refuses to rewind.
--
-- Keep history, suppress the false current-state event.

create or replace function public.caye_suppress_out_of_order_perception_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source_kind text;
  v_source_identity text;
  v_subject_id text;
  v_current_observed_at timestamptz;
begin
  if new.type <> 'observation.property_telemetry' then
    return new;
  end if;

  v_source_kind := new.payload #>> '{source,kind}';
  v_source_identity := new.payload #>> '{source,identity}';
  v_subject_id := new.payload #>> '{source,device_id}';

  if v_source_kind is null or v_source_identity is null or v_subject_id is null then
    -- Malformed provenance is not silently discarded here. The canonical event remains
    -- visible so bad producer behavior can be diagnosed instead of becoming invisible.
    return new;
  end if;

  select last_observed_at
    into v_current_observed_at
    from public.perception_source_state
   where workspace_id = new.workspace_id
     and source_kind = v_source_kind
     and source_identity = v_source_identity
     and subject_kind = 'property_sensor_device'
     and subject_id = v_subject_id
   limit 1;

  if v_current_observed_at is not null and new.occurred_at < v_current_observed_at then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_caye_suppress_out_of_order_perception_event
  on public.workspace_events;
create trigger trg_caye_suppress_out_of_order_perception_event
  before insert on public.workspace_events
  for each row
  when (new.type = 'observation.property_telemetry')
  execute function public.caye_suppress_out_of_order_perception_event();

revoke execute on function public.caye_suppress_out_of_order_perception_event()
  from public, anon, authenticated;

comment on function public.caye_suppress_out_of_order_perception_event() is
  'Prevents delayed property telemetry from masquerading as a new current-state change while preserving the authoritative raw telemetry history.';
