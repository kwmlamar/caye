-- Preserve the pre-perception telemetry contract: a registered device heartbeat advances
-- even when an authenticated uplink contains no supported metric and is retained as rejected.
-- The perception layer does not treat that payload as an observation, but receiving it still
-- proves the registered device was alive at p_observed_at.

create or replace function public.caye_property_telemetry_rejected_heartbeat()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.processing_status = 'rejected'
     and old.processing_status is distinct from new.processing_status then
    update public.property_sensor_devices
       set last_seen_at = case
             when last_seen_at is null then new.observed_at
             else greatest(last_seen_at, new.observed_at)
           end,
           status = 'active',
           updated_at = now()
     where id = new.device_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_caye_property_telemetry_rejected_heartbeat
  on public.property_telemetry_events;
create trigger trg_caye_property_telemetry_rejected_heartbeat
  after update of processing_status on public.property_telemetry_events
  for each row execute function public.caye_property_telemetry_rejected_heartbeat();

revoke execute on function public.caye_property_telemetry_rejected_heartbeat() from public, anon, authenticated;
