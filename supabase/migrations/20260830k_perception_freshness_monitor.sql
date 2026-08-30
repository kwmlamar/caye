-- Perception freshness monitor
--
-- Turns freshness from a passive timestamp into durable monitored state.
-- A source that was active but has exceeded fresh_until transitions to stale exactly once
-- until a new real observation reactivates it through the existing ingest path.
--
-- This is monitoring only. It does not send notifications or grant execution authority.

create or replace function public.refresh_perception_freshness(
  p_now timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source public.perception_source_state%rowtype;
  v_stale_count integer := 0;
  v_device_count integer := 0;
  v_event_count integer := 0;
  v_capability_count integer := 0;
  v_affected integer := 0;
begin
  for v_source in
    select *
      from public.perception_source_state
     where status = 'active'
       and fresh_until is not null
       and fresh_until < p_now
     order by fresh_until asc, id asc
     for update skip locked
  loop
    update public.perception_source_state
       set status = 'stale',
           updated_at = p_now
     where id = v_source.id
       and status = 'active'
       and fresh_until is not null
       and fresh_until < p_now;

    if not found then
      continue;
    end if;

    v_stale_count := v_stale_count + 1;

    update public.perception_capability_evidence
       set status = 'limited',
           autonomous_now = false,
           updated_at = p_now
     where workspace_id = v_source.workspace_id
       and source_kind = v_source.source_kind
       and source_identity = v_source.source_identity
       and status = 'active';
    get diagnostics v_affected = row_count;
    v_capability_count := v_capability_count + v_affected;

    if v_source.source_kind = 'property.telemetry'
       and v_source.subject_kind = 'property_sensor_device'
       and v_source.subject_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      update public.property_sensor_devices
         set status = 'stale',
             updated_at = p_now
       where id = v_source.subject_id::uuid
         and workspace_id = v_source.workspace_id
         and status = 'active';
      get diagnostics v_affected = row_count;
      v_device_count := v_device_count + v_affected;
    end if;

    insert into public.workspace_events (
      workspace_id,
      occurred_at,
      type,
      actor_kind,
      is_failure,
      subject_table,
      subject_id,
      payload,
      origin
    ) values (
      v_source.workspace_id,
      p_now,
      'monitoring.perception_source_stale',
      'system',
      false,
      'perception_source_state',
      v_source.id::text,
      jsonb_build_object(
        'epistemic_kind', 'inference',
        'inference_kind', 'freshness_expired',
        'anomaly', true,
        'importance', 'attention',
        'severity', 'warning',
        'confidence', 1.0,
        'source', jsonb_build_object(
          'kind', v_source.source_kind,
          'identity', v_source.source_identity,
          'subject_kind', v_source.subject_kind,
          'subject_id', v_source.subject_id
        ),
        'last_observed_at', v_source.last_observed_at,
        'fresh_until', v_source.fresh_until,
        'detected_at', p_now
      ),
      'app'
    );
    v_event_count := v_event_count + 1;
  end loop;

  return jsonb_build_object(
    'status', 'completed',
    'checked_at', p_now,
    'sources_marked_stale', v_stale_count,
    'capabilities_downgraded', v_capability_count,
    'devices_marked_stale', v_device_count,
    'events_emitted', v_event_count
  );
end;
$$;

-- Recovery must be visible even when the recovered reading has the same value as the
-- last pre-stale reading. The telemetry change filter correctly suppresses that unchanged
-- metric event, so observe the durable source-state transition instead.
--
-- Require a newer source observation and a freshness deadline still in the future. This
-- prevents a delayed already-expired packet from masquerading as a genuine recovery event.
create or replace function public.caye_event_on_perception_source_recovery()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = 'stale'
     and new.status = 'active'
     and new.last_observed_at is not null
     and (old.last_observed_at is null or new.last_observed_at > old.last_observed_at)
     and new.fresh_until is not null
     and new.fresh_until > now() then
    insert into public.workspace_events (
      workspace_id,
      occurred_at,
      type,
      actor_kind,
      is_failure,
      subject_table,
      subject_id,
      payload,
      origin
    ) values (
      new.workspace_id,
      new.last_observed_at,
      'monitoring.perception_source_recovered',
      'system',
      false,
      'perception_source_state',
      new.id::text,
      jsonb_build_object(
        'epistemic_kind', 'inference',
        'inference_kind', 'fresh_observation_reactivated_source',
        'anomaly', false,
        'importance', 'routine',
        'severity', 'info',
        'confidence', new.confidence,
        'source', jsonb_build_object(
          'kind', new.source_kind,
          'identity', new.source_identity,
          'subject_kind', new.subject_kind,
          'subject_id', new.subject_id,
          'source_event_id', new.last_source_event_id
        ),
        'last_observed_at', new.last_observed_at,
        'fresh_until', new.fresh_until,
        'recovered_at', now()
      ),
      'app'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_caye_perception_source_recovery
  on public.perception_source_state;
create trigger trg_caye_perception_source_recovery
  after update of status, last_observed_at, fresh_until on public.perception_source_state
  for each row
  when (old.status = 'stale' and new.status = 'active')
  execute function public.caye_event_on_perception_source_recovery();

revoke all on function public.refresh_perception_freshness(timestamptz) from public;
revoke all on function public.refresh_perception_freshness(timestamptz) from anon;
revoke all on function public.refresh_perception_freshness(timestamptz) from authenticated;
grant execute on function public.refresh_perception_freshness(timestamptz) to service_role;

revoke execute on function public.caye_event_on_perception_source_recovery()
  from public, anon, authenticated;

comment on function public.refresh_perception_freshness(timestamptz) is
  'Service-role-only atomic freshness sweep: transitions expired active perception sources to stale, downgrades live evidence, marks linked property sensors stale, and records a monitoring inference event. Does not notify or execute operational actions.';
comment on function public.caye_event_on_perception_source_recovery() is
  'Records a canonical recovery inference only when stale perception state is reactivated by a newer observation that is still fresh at write time.';
