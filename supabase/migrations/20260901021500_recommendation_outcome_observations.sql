-- Bounded observation ledger for executed recommendation actions.
-- This schedules observation only. It does not grade recommendations, execute actions,
-- poll arbitrary destinations, or modify authority. #372 remains the outcome evaluator.

create table if not exists public.caye_recommendation_outcome_observations (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references public.caye_recommendations(id) on delete cascade,
  decision_id uuid not null references public.caye_recommendation_decisions(id) on delete cascade,
  recommendation_fingerprint text not null,
  execution_key text not null check (length(btrim(execution_key)) > 0),
  scope text not null check (scope in ('operator','workspace')),
  workspace_id uuid references public.customers(id) on delete cascade,
  observer_key text not null check (length(btrim(observer_key)) > 0),
  expected_effect jsonb not null default '{}'::jsonb,
  state text not null default 'pending' check (state in ('pending','satisfied','expired','unknown')),
  registered_at timestamptz not null default now(),
  next_observation_at timestamptz,
  expires_at timestamptz not null,
  cadence_seconds integer not null check (cadence_seconds between 60 and 604800),
  max_observations integer not null check (max_observations between 1 and 32),
  observation_count integer not null default 0 check (observation_count between 0 and 32),
  last_observed_at timestamptz,
  fingerprint text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint caye_recommendation_observation_scope_workspace_pairing check (
    (scope = 'workspace' and workspace_id is not null) or
    (scope = 'operator' and workspace_id is null)
  ),
  constraint caye_recommendation_observation_bounded_horizon check (
    expires_at > registered_at and expires_at <= registered_at + interval '30 days'
  )
);

create index if not exists caye_recommendation_observation_due_idx
  on public.caye_recommendation_outcome_observations(next_observation_at)
  where state = 'pending';
create index if not exists caye_recommendation_observation_rec_idx
  on public.caye_recommendation_outcome_observations(recommendation_id, created_at desc);

alter table public.caye_recommendation_outcome_observations enable row level security;
revoke all on public.caye_recommendation_outcome_observations from anon, authenticated;

create or replace function public.register_caye_recommendation_outcome_observation(
  p_recommendation_id uuid,
  p_decision_id uuid,
  p_workspace_id uuid,
  p_execution_key text,
  p_observer_key text,
  p_expected_effect jsonb,
  p_next_observation_at timestamptz,
  p_expires_at timestamptz,
  p_cadence_seconds integer,
  p_max_observations integer
)
returns public.caye_recommendation_outcome_observations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec public.caye_recommendations%rowtype;
  v_decision public.caye_recommendation_decisions%rowtype;
  v_row public.caye_recommendation_outcome_observations%rowtype;
  v_fingerprint text;
begin
  select * into v_rec from public.caye_recommendations where id = p_recommendation_id for share;
  if not found then raise exception 'recommendation observation recommendation not found'; end if;
  if v_rec.workspace_id is distinct from p_workspace_id then raise exception 'recommendation observation workspace mismatch'; end if;

  select * into v_decision from public.caye_recommendation_decisions where id = p_decision_id for share;
  if not found then raise exception 'recommendation observation decision not found'; end if;
  if v_decision.recommendation_id is distinct from v_rec.id
     or v_decision.recommendation_fingerprint is distinct from v_rec.fingerprint
     or v_decision.workspace_id is distinct from p_workspace_id then
    raise exception 'recommendation observation decision/version mismatch';
  end if;

  if length(btrim(coalesce(p_execution_key,''))) = 0 or length(btrim(coalesce(p_observer_key,''))) = 0 then
    raise exception 'recommendation observation requires execution and observer keys';
  end if;
  if p_cadence_seconds not between 60 and 604800 or p_max_observations not between 1 and 32 then
    raise exception 'recommendation observation bounds invalid';
  end if;
  if p_next_observation_at is null or p_expires_at is null
     or p_expires_at <= now() or p_expires_at > now() + interval '30 days'
     or p_next_observation_at > p_expires_at then
    raise exception 'recommendation observation horizon invalid';
  end if;

  v_fingerprint := encode(digest(concat_ws('|',
    'caye-recommendation-observation-v1', v_rec.id::text, v_decision.id::text,
    v_rec.fingerprint, btrim(p_execution_key), btrim(p_observer_key)
  ), 'sha256'), 'hex');

  insert into public.caye_recommendation_outcome_observations (
    recommendation_id, decision_id, recommendation_fingerprint, execution_key,
    scope, workspace_id, observer_key, expected_effect, next_observation_at,
    expires_at, cadence_seconds, max_observations, fingerprint
  ) values (
    v_rec.id, v_decision.id, v_rec.fingerprint, btrim(p_execution_key),
    v_rec.scope, v_rec.workspace_id, btrim(p_observer_key), coalesce(p_expected_effect, '{}'::jsonb),
    p_next_observation_at, p_expires_at, p_cadence_seconds, p_max_observations, v_fingerprint
  ) on conflict (fingerprint) do nothing returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.caye_recommendation_outcome_observations where fingerprint = v_fingerprint;
  end if;
  return v_row;
end;
$$;

create or replace function public.advance_caye_recommendation_outcome_observation(
  p_observation_id uuid,
  p_state text,
  p_next_observation_at timestamptz,
  p_observed_at timestamptz default now()
)
returns public.caye_recommendation_outcome_observations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.caye_recommendation_outcome_observations%rowtype;
begin
  if p_state not in ('pending','satisfied','expired','unknown') then
    raise exception 'unsupported recommendation observation state';
  end if;

  select * into v_row from public.caye_recommendation_outcome_observations where id = p_observation_id for update;
  if not found then raise exception 'recommendation observation not found'; end if;
  if v_row.state <> 'pending' then return v_row; end if;

  v_row.observation_count := v_row.observation_count + 1;
  if p_state = 'pending' and (
    v_row.observation_count >= v_row.max_observations
    or coalesce(p_next_observation_at, v_row.expires_at) >= v_row.expires_at
  ) then
    p_state := 'expired';
    p_next_observation_at := null;
  end if;

  update public.caye_recommendation_outcome_observations set
    state = p_state,
    observation_count = v_row.observation_count,
    last_observed_at = coalesce(p_observed_at, now()),
    next_observation_at = case when p_state = 'pending' then p_next_observation_at else null end,
    updated_at = now()
  where id = v_row.id
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.register_caye_recommendation_outcome_observation(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,integer) from public, anon, authenticated;
revoke all on function public.advance_caye_recommendation_outcome_observation(uuid,text,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.register_caye_recommendation_outcome_observation(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,integer) to service_role;
grant execute on function public.advance_caye_recommendation_outcome_observation(uuid,text,timestamptz,timestamptz) to service_role;
