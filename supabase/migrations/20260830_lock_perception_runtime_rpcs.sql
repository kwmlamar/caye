-- Security-definer perception RPCs are server-only. Existing databases may have
-- explicit anon/authenticated routine grants, so revoke those roles directly.
revoke execute on function public.observe_workspace_event_stream(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.run_workspace_event_perception_cycle(integer) from public, anon, authenticated;

grant execute on function public.observe_workspace_event_stream(uuid, timestamptz) to service_role;
grant execute on function public.run_workspace_event_perception_cycle(integer) to service_role;
