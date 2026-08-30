-- Defense in depth for internal operator/perception runtime state.
-- RLS already has no client policies, but remove inherited table privileges too
-- so a future policy cannot accidentally expose these internal audit/state rows.

revoke all on table public.operator_objective_runs from public, anon, authenticated;
revoke all on table public.operator_objective_events from public, anon, authenticated;
revoke all on table public.perception_source_state from public, anon, authenticated;
revoke all on table public.perception_capability_evidence from public, anon, authenticated;

grant select, insert, update, delete on table public.operator_objective_runs to service_role;
grant select, insert, update, delete on table public.operator_objective_events to service_role;
grant select, insert, update, delete on table public.perception_source_state to service_role;
grant select, insert, update, delete on table public.perception_capability_evidence to service_role;

grant usage, select on sequence public.operator_objective_events_id_seq to service_role;
