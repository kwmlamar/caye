-- Prefer the most recently active workspaces before applying the bounded perception-cycle limit.
-- The prior DISTINCT ON query ordered by workspace_id first, which could starve higher-sorting
-- workspace UUIDs once the active workspace count exceeded the cycle limit.
create or replace function public.run_workspace_event_perception_cycle(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source record;
  v_result jsonb;
  v_processed integer := 0;
  v_changed integer := 0;
  v_unchanged integer := 0;
  v_failed integer := 0;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  for v_source in
    select workspace_id, id, occurred_at, type
      from (
        select distinct on (workspace_id)
               workspace_id, id, occurred_at, type
          from public.workspace_events
         where type not like 'observation.%'
         order by workspace_id, id desc
      ) latest_by_workspace
     order by occurred_at desc, id desc
     limit v_limit
  loop
    begin
      v_result := public.observe_workspace_event_stream(v_source.workspace_id, now());
      v_processed := v_processed + 1;
      if coalesce(v_result->>'change_kind', '') = 'unchanged' then
        v_unchanged := v_unchanged + 1;
      elsif coalesce(v_result->>'status', '') = 'accepted' then
        v_changed := v_changed + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
      update public.perception_source_state
         set status = 'degraded',
             consecutive_failures = consecutive_failures + 1,
             last_failure_at = now(),
             last_failure_code = 'observer_error',
             retry_after = now() + interval '5 minutes',
             updated_at = now()
       where workspace_id = v_source.workspace_id
         and source_kind = 'system.workspace_event_stream'
         and source_identity = 'workspace_events'
         and subject_kind = 'workspace_event_stream'
         and subject_id = v_source.workspace_id::text;
    end;
  end loop;

  return jsonb_build_object(
    'status', case when v_failed = 0 then 'ok' else 'partial_failure' end,
    'processed', v_processed,
    'changed', v_changed,
    'unchanged', v_unchanged,
    'failed', v_failed,
    'limit', v_limit
  );
end;
$$;

revoke execute on function public.run_workspace_event_perception_cycle(integer) from public, anon, authenticated;
grant execute on function public.run_workspace_event_perception_cycle(integer) to service_role;

comment on function public.run_workspace_event_perception_cycle(integer) is
'Runs the canonical workspace-event perception observer for the most recently active bounded set of real workspace sources. Failures are isolated per workspace and retried by the scheduler.';
