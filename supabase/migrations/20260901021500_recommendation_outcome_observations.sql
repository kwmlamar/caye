-- Bounded observation ledger for executed recommendation actions.
-- This schedules objective observation only. It does not grade recommendations,
-- execute actions, poll arbitrary destinations, or modify authority. #372 remains
-- the only recommendation outcome evaluator.

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
  claimed_by text,
  claim_token uuid,
  claim_expires_at timestamptz,
  fingerprint text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint caye_recommendation_observation_scope_workspace_pairing check (
    (scope = 'workspace' and workspace_id is not null) or
    (scope = 'operator' and workspace_id is null)
  ),
  constraint caye_recommendation_observation_bounded_horizon check (
    expires_at > registered_at and expires_at <= registered_at + interval '30 days'
  ),
  constraint caye_recommendation_observation_claim_pair check (
    (claim_token is null and claimed_by is null and claim_expires_at is null) or
    (claim_token is not null and claimed_by is not null and claim_expires_at is not null)
  )
);

-- Objective measurements produced by code-owned observers. attempt_index is the
-- stable identity for a scheduled sample: a worker crash after this write but
-- before advancing the observation reuses the same row on lease recovery.
create table if not exists public.caye_recommendation_outcome_observation_measurements (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references public.caye_recommendation_outcome_observations(id) on delete cascade,
  attempt_index integer not null check (attempt_index between 1 and 32),
  metric_key text not null check (length(btrim(metric_key)) > 0),
  baseline_value numeric,
  observed_value numeric,
  measured_delta numeric,
  unit text,
  direction text not null check (direction in ('positive','negative','neutral','unknown')),
  measurable boolean not null default false,
  observed_at timestamptz not null,
  provenance jsonb not null,
  fingerprint text not null unique,
  created_at timestamptz not null default now(),
  unique (observation_id, attempt_index, metric_key)
);

create index if not exists caye_recommendation_observation_due_idx
  on public.caye_recommendation_outcome_observations(next_observation_at)
  where state = 'pending';
create index if not exists caye_recommendation_observation_rec_idx
  on public.caye_recommendation_outcome_observations(recommendation_id, created_at desc);
create index if not exists caye_recommendation_observation_measurement_idx
  on public.caye_recommendation_outcome_observation_measurements(observation_id, attempt_index);

alter table public.caye_recommendation_outcome_observations enable row level security;
alter table public.caye_recommendation_outcome_observation_measurements enable row level security;
revoke all on public.caye_recommendation_outcome_observations,
              public.caye_recommendation_outcome_observation_measurements
  from anon, authenticated;

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
language plpgsql security definer set search_path = public
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
    'caye-recommendation-observation-v2', v_rec.id::text, v_decision.id::text,
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
  if v_row.id is null then select * into v_row from public.caye_recommendation_outcome_observations where fingerprint = v_fingerprint; end if;
  return v_row;
end;
$$;

-- One due claim per call. SKIP LOCKED and the lease converge duplicate cron invocations.
create or replace function public.claim_due_caye_recommendation_outcome_observation(
  p_worker text, p_now timestamptz default now()
)
returns public.caye_recommendation_outcome_observations
language plpgsql security definer set search_path = public
as $$
declare
  v_row public.caye_recommendation_outcome_observations%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if length(btrim(coalesce(p_worker,''))) = 0 then raise exception 'observation worker required'; end if;
  select * into v_row from public.caye_recommendation_outcome_observations
  where state = 'pending' and next_observation_at is not null and next_observation_at <= p_now
    and observation_count < max_observations and (claim_token is null or claim_expires_at <= p_now)
  order by next_observation_at, created_at for update skip locked limit 1;
  if v_row.id is null then return null; end if;
  update public.caye_recommendation_outcome_observations
  set claimed_by = btrim(p_worker), claim_token = v_token,
      claim_expires_at = p_now + interval '5 minutes', updated_at = now()
  where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.record_caye_recommendation_outcome_observation_measurement(
  p_observation_id uuid, p_claim_token uuid, p_metric_key text,
  p_baseline_value numeric, p_observed_value numeric, p_measured_delta numeric,
  p_unit text, p_direction text, p_measurable boolean,
  p_observed_at timestamptz, p_provenance jsonb
)
returns public.caye_recommendation_outcome_observation_measurements
language plpgsql security definer set search_path = public
as $$
declare
  v_observation public.caye_recommendation_outcome_observations%rowtype;
  v_row public.caye_recommendation_outcome_observation_measurements%rowtype;
  v_attempt integer;
  v_fingerprint text;
begin
  select * into v_observation from public.caye_recommendation_outcome_observations where id = p_observation_id for share;
  if not found then raise exception 'recommendation observation not found'; end if;
  if v_observation.state <> 'pending' or v_observation.claim_token is distinct from p_claim_token
     or v_observation.claim_expires_at <= now() then raise exception 'recommendation observation claim invalid'; end if;
  if length(btrim(coalesce(p_metric_key,''))) = 0 then raise exception 'observation metric key required'; end if;
  if p_direction not in ('positive','negative','neutral','unknown') then raise exception 'unsupported observation metric direction'; end if;
  if p_provenance is null or jsonb_typeof(p_provenance) <> 'object' or p_provenance = '{}'::jsonb then
    raise exception 'observation measurement provenance required';
  end if;

  v_attempt := v_observation.observation_count + 1;
  v_fingerprint := encode(digest(concat_ws('|',
    'caye-recommendation-observation-measurement-v2', v_observation.id::text,
    v_attempt::text, btrim(p_metric_key)
  ), 'sha256'), 'hex');

  insert into public.caye_recommendation_outcome_observation_measurements (
    observation_id, attempt_index, metric_key, baseline_value, observed_value,
    measured_delta, unit, direction, measurable, observed_at, provenance, fingerprint
  ) values (
    v_observation.id, v_attempt, btrim(p_metric_key), p_baseline_value, p_observed_value,
    p_measured_delta, nullif(btrim(coalesce(p_unit,'')),''), p_direction, p_measurable,
    coalesce(p_observed_at, now()), p_provenance, v_fingerprint
  ) on conflict (fingerprint) do nothing returning * into v_row;
  if v_row.id is null then select * into v_row from public.caye_recommendation_outcome_observation_measurements where fingerprint = v_fingerprint; end if;
  return v_row;
end;
$$;

create or replace function public.advance_caye_recommendation_outcome_observation(
  p_observation_id uuid, p_claim_token uuid, p_state text,
  p_next_observation_at timestamptz, p_observed_at timestamptz default now()
)
returns public.caye_recommendation_outcome_observations
language plpgsql security definer set search_path = public
as $$
declare v_row public.caye_recommendation_outcome_observations%rowtype;
begin
  if p_state not in ('pending','satisfied','expired','unknown') then raise exception 'unsupported recommendation observation state'; end if;
  select * into v_row from public.caye_recommendation_outcome_observations where id = p_observation_id for update;
  if not found then raise exception 'recommendation observation not found'; end if;
  if v_row.state <> 'pending' then return v_row; end if;
  if v_row.claim_token is distinct from p_claim_token or v_row.claim_expires_at <= now() then raise exception 'recommendation observation claim invalid'; end if;
  v_row.observation_count := v_row.observation_count + 1;
  if p_state = 'pending' and (
    v_row.observation_count >= v_row.max_observations or coalesce(p_next_observation_at, v_row.expires_at) >= v_row.expires_at
  ) then p_state := 'expired'; p_next_observation_at := null; end if;
  update public.caye_recommendation_outcome_observations set
    state = p_state, observation_count = v_row.observation_count,
    last_observed_at = coalesce(p_observed_at, now()),
    next_observation_at = case when p_state = 'pending' then p_next_observation_at else null end,
    claimed_by = null, claim_token = null, claim_expires_at = null, updated_at = now()
  where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.register_caye_recommendation_outcome_observation(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,integer) from public, anon, authenticated;
revoke all on function public.claim_due_caye_recommendation_outcome_observation(text,timestamptz) from public, anon, authenticated;
revoke all on function public.record_caye_recommendation_outcome_observation_measurement(uuid,uuid,text,numeric,numeric,numeric,text,text,boolean,timestamptz,jsonb) from public, anon, authenticated;
revoke all on function public.advance_caye_recommendation_outcome_observation(uuid,uuid,text,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.register_caye_recommendation_outcome_observation(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,integer) to service_role;
grant execute on function public.claim_due_caye_recommendation_outcome_observation(text,timestamptz) to service_role;
grant execute on function public.record_caye_recommendation_outcome_observation_measurement(uuid,uuid,text,numeric,numeric,numeric,text,text,boolean,timestamptz,jsonb) to service_role;
grant execute on function public.advance_caye_recommendation_outcome_observation(uuid,uuid,text,timestamptz,timestamptz) to service_role;
