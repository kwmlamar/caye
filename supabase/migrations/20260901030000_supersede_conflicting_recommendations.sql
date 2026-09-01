-- Deterministically retire older executable recommendations when newer
-- contradictory evidence produces a replacement for the same goal.
--
-- This is deliberately narrow: only recommendations produced by the material
-- intelligence runtime with contradiction-resolution provenance participate.
-- The replacement is persisted first, then incompatible predecessors for the
-- same canonical goal/scope are retired in the same database transaction.

create or replace function public.supersede_conflicting_caye_recommendations(
  p_recommendation_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new public.caye_recommendations%rowtype;
  v_count integer := 0;
begin
  select * into v_new
  from public.caye_recommendations
  where id = p_recommendation_id
  for update;

  if not found then raise exception 'replacement recommendation not found'; end if;

  -- Only contradiction-resolution recommendations may retire predecessors.
  -- Ordinary new proposals never silently invalidate an accepted decision.
  if coalesce(v_new.provenance->>'source', '') <> 'material-intelligence-recommendation-runtime'
     or coalesce(v_new.provenance->>'trigger', '') <> 'contradiction-resolution' then
    return 0;
  end if;

  update public.caye_recommendations old
  set status = 'superseded',
      superseded_by = v_new.id,
      superseded_at = now(),
      updated_at = now()
  where old.id <> v_new.id
    and old.goal_id = v_new.goal_id
    and old.scope = v_new.scope
    and old.workspace_id is not distinct from v_new.workspace_id
    and old.status in ('proposed', 'accepted', 'deferred')
    and old.superseded_at is null
    and coalesce(old.provenance->>'source', '') = 'material-intelligence-recommendation-runtime';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.supersede_conflicting_caye_recommendations(uuid)
  from public, anon, authenticated;
grant execute on function public.supersede_conflicting_caye_recommendations(uuid)
  to service_role;

comment on function public.supersede_conflicting_caye_recommendations(uuid) is
  'Fail-closed conflict retirement for contradiction-resolution material-intelligence recommendations. Explicit superseded state makes older accepted recommendations execution-ineligible.';
