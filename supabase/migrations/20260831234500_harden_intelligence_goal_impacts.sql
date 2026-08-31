-- Keep cross-domain objective impacts inside the same internal intelligence authority boundary.
-- The table is written only by service-side synthesis and must never be mutable from browser roles.

alter table public.intelligence_goal_impacts enable row level security;

revoke all on public.intelligence_goal_impacts from anon, authenticated;

revoke execute on function public.upsert_grounded_intelligence_goal_impact(
  uuid, uuid, text, text, numeric, uuid[], text, jsonb
) from public, anon, authenticated;

grant execute on function public.upsert_grounded_intelligence_goal_impact(
  uuid, uuid, text, text, numeric, uuid[], text, jsonb
) to service_role;
