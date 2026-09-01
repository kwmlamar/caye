-- Recommendation outcome learning and deterministic calibration.
-- Canonical chain: recommendation -> canonical decision -> observed evidence -> outcome.
-- Decision state never determines outcome quality. Execution can prove followed state,
-- but only measured objective evidence grades impact. Later research may contradict a
-- thesis, but supporting research alone can never award success. Authority is untouched.

create table if not exists public.caye_recommendation_outcomes (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references public.caye_recommendations(id) on delete restrict,
  decision_id uuid not null references public.caye_recommendation_decisions(id) on delete restrict,
  scope text not null check (scope in ('operator','workspace')),
  workspace_id uuid references public.customers(id) on delete cascade,
  goal_id uuid not null references public.caye_goals(id) on delete restrict,
  outcome_status text not null check (outcome_status in ('success','failure','no_benefit','unknown')),
  objective_effect text not null check (objective_effect in ('helped','hurt','neutral','unknown')),
  was_followed boolean,
  observed_outcome text not null,
  actual_impact jsonb not null default '{}'::jsonb,
  expected_vs_actual jsonb not null default '{}'::jsonb,
  confidence_at_recommendation numeric(4,3) not null check (confidence_at_recommendation between 0 and 1),
  contradicted_by_later_evidence boolean not null default false,
  evidence_conflict boolean not null default false,
  evaluator_provenance jsonb not null,
  fingerprint text not null unique,
  evaluated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint caye_recommendation_outcomes_scope_workspace_pairing check (
    (scope = 'workspace' and workspace_id is not null) or
    (scope = 'operator' and workspace_id is null)
  )
);

create table if not exists public.caye_recommendation_outcome_evidence (
  outcome_id uuid not null references public.caye_recommendation_outcomes(id) on delete cascade,
  evidence_kind text not null check (evidence_kind in ('system_metric','goal_metric','execution_result','intelligence','research')),
  source_table text not null check (length(btrim(source_table)) > 0),
  source_id text not null check (length(btrim(source_id)) > 0),
  observed_at timestamptz not null,
  direction text not null check (direction in ('positive','negative','neutral','supports','contradicts','unknown')),
  measurable boolean not null default false,
  measured_delta numeric,
  unit text,
  followed boolean,
  provenance jsonb not null,
  created_at timestamptz not null default now(),
  primary key (outcome_id, evidence_kind, source_table, source_id),
  constraint caye_recommendation_execution_followed_only check (
    followed is null or evidence_kind = 'execution_result'
  )
);

create table if not exists public.caye_recommendation_founder_feedback (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references public.caye_recommendations(id) on delete restrict,
  decision_id uuid references public.caye_recommendation_decisions(id) on delete set null,
  outcome_id uuid references public.caye_recommendation_outcomes(id) on delete set null,
  workspace_id uuid references public.customers(id) on delete cascade,
  usefulness text check (usefulness is null or usefulness in ('useful','not_useful','mixed','unknown')),
  timing text check (timing is null or timing in ('too_early','on_time','too_late','unknown')),
  noisiness text check (noisiness is null or noisiness in ('material','too_noisy','unknown')),
  feedback text,
  provenance jsonb not null,
  fingerprint text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists caye_recommendation_outcomes_workspace_eval_idx
  on public.caye_recommendation_outcomes(workspace_id, evaluated_at desc) where scope = 'workspace';
create index if not exists caye_recommendation_outcomes_goal_eval_idx
  on public.caye_recommendation_outcomes(goal_id, evaluated_at desc);
create index if not exists caye_recommendation_outcomes_status_idx
  on public.caye_recommendation_outcomes(outcome_status, confidence_at_recommendation);
create index if not exists caye_recommendation_outcome_evidence_source_idx
  on public.caye_recommendation_outcome_evidence(evidence_kind, source_table, source_id);
create index if not exists caye_recommendation_feedback_rec_idx
  on public.caye_recommendation_founder_feedback(recommendation_id, created_at desc);

alter table public.caye_recommendation_outcomes enable row level security;
alter table public.caye_recommendation_outcome_evidence enable row level security;
alter table public.caye_recommendation_founder_feedback enable row level security;
revoke all on public.caye_recommendation_outcomes,
              public.caye_recommendation_outcome_evidence,
              public.caye_recommendation_founder_feedback
  from anon, authenticated;

create or replace function public.evaluate_caye_recommendation_outcome(
  p_recommendation_id uuid,
  p_decision_id uuid,
  p_workspace_id uuid,
  p_evidence jsonb,
  p_evaluator_provenance jsonb,
  p_evaluated_at timestamptz default now()
)
returns public.caye_recommendation_outcomes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec public.caye_recommendations%rowtype;
  v_decision public.caye_recommendation_decisions%rowtype;
  v_row public.caye_recommendation_outcomes%rowtype;
  v_evidence jsonb := coalesce(p_evidence, '[]'::jsonb);
  v_canonical_evidence jsonb;
  v_status text := 'unknown';
  v_effect text := 'unknown';
  v_followed boolean;
  v_saw_followed_false boolean := false;
  v_contradicted boolean := false;
  v_objective_positive boolean := false;
  v_objective_negative boolean := false;
  v_objective_neutral boolean := false;
  v_conflict boolean := false;
  v_observed text;
  v_fingerprint text;
  v_measured_signals jsonb;
  v_e jsonb;
  v_kind text;
  v_direction text;
  v_measurable boolean;
begin
  select * into v_rec from public.caye_recommendations where id = p_recommendation_id for share;
  if not found then raise exception 'recommendation outcome recommendation not found'; end if;
  if v_rec.workspace_id is distinct from p_workspace_id then
    raise exception 'recommendation outcome workspace mismatch';
  end if;

  select * into v_decision from public.caye_recommendation_decisions where id = p_decision_id for share;
  if not found then raise exception 'recommendation outcome decision not found'; end if;
  if v_decision.recommendation_id is distinct from v_rec.id
     or v_decision.recommendation_fingerprint is distinct from v_rec.fingerprint then
    raise exception 'canonical decision does not match recommendation version';
  end if;
  if v_decision.workspace_id is distinct from p_workspace_id
     or v_decision.scope is distinct from v_rec.scope then
    raise exception 'recommendation outcome decision workspace mismatch';
  end if;

  if p_evaluator_provenance is null
     or jsonb_typeof(p_evaluator_provenance) <> 'object'
     or p_evaluator_provenance = '{}'::jsonb then
    raise exception 'recommendation outcome requires evaluator provenance';
  end if;
  if lower(coalesce(p_evaluator_provenance->>'kind','')) in ('model','llm','self_report') then
    raise exception 'model self-evaluation is not outcome evidence';
  end if;
  if jsonb_typeof(v_evidence) <> 'array' then
    raise exception 'recommendation outcome evidence must be an array';
  end if;

  select coalesce(jsonb_agg(e order by e->>'evidence_kind', e->>'source_table', e->>'source_id', e::text), '[]'::jsonb)
  into v_canonical_evidence from jsonb_array_elements(v_evidence) e;

  for v_e in select value from jsonb_array_elements(v_canonical_evidence) loop
    v_kind := coalesce(v_e->>'evidence_kind','');
    v_direction := coalesce(v_e->>'direction','unknown');
    v_measurable := coalesce((v_e->>'measurable')::boolean, false);

    if v_kind not in ('system_metric','goal_metric','execution_result','intelligence','research') then
      raise exception 'unsupported recommendation outcome evidence kind';
    end if;
    if length(btrim(coalesce(v_e->>'source_table',''))) = 0
       or length(btrim(coalesce(v_e->>'source_id',''))) = 0 then
      raise exception 'outcome evidence requires durable source reference';
    end if;
    if jsonb_typeof(coalesce(v_e->'provenance','{}'::jsonb)) <> 'object'
       or coalesce(v_e->'provenance','{}'::jsonb) = '{}'::jsonb then
      raise exception 'outcome evidence requires provenance';
    end if;
    if lower(coalesce(v_e#>>'{provenance,kind}','')) in ('model','llm','self_report') then
      raise exception 'model-generated evidence cannot grade recommendations';
    end if;

    if v_kind in ('intelligence','research') then
      if v_direction not in ('supports','contradicts','unknown') then
        raise exception 'intelligence/research evidence may only support or contradict the recommendation thesis';
      end if;
      if v_e ? 'followed' or v_measurable then
        raise exception 'intelligence/research evidence cannot claim execution or measured objective impact';
      end if;
      v_contradicted := v_contradicted or v_direction = 'contradicts';
    else
      if v_direction not in ('positive','negative','neutral','unknown') then
        raise exception 'metric/execution evidence requires an objective direction';
      end if;
      if v_kind <> 'execution_result' and v_direction <> 'unknown' and not v_measurable then
        raise exception 'system/goal metric outcome evidence must be measurable';
      end if;
      if (v_e ? 'followed') and v_kind <> 'execution_result' then
        raise exception 'followed state requires execution-result evidence';
      end if;
      if v_kind = 'execution_result' and v_e ? 'followed' then
        if (v_e->>'followed')::boolean then v_followed := true;
        else v_saw_followed_false := true; end if;
      end if;

      -- Execution completion alone proves followed state. It grades quality only
      -- when it also contains a measured outcome.
      if v_kind in ('system_metric','goal_metric') or (v_kind = 'execution_result' and v_measurable) then
        v_objective_positive := v_objective_positive or v_direction = 'positive';
        v_objective_negative := v_objective_negative or v_direction = 'negative';
        v_objective_neutral := v_objective_neutral or v_direction = 'neutral';
      end if;
    end if;
  end loop;

  if v_followed is null and v_saw_followed_false then v_followed := false; end if;
  v_conflict := v_objective_positive and v_objective_negative;

  -- Accepted/rejected/deferred/cancelled are intentionally absent from this policy.
  if v_conflict then
    v_status := 'unknown'; v_effect := 'unknown';
  elsif v_objective_negative then
    v_status := 'failure'; v_effect := 'hurt';
  elsif v_objective_positive then
    v_status := 'success'; v_effect := 'helped';
  elsif v_objective_neutral then
    v_status := 'no_benefit'; v_effect := 'neutral';
  elsif v_contradicted then
    v_status := 'failure'; v_effect := 'unknown';
  end if;

  v_observed := case
    when v_conflict then 'Objective evidence conflicts; recommendation quality remains unknown pending reconciliation.'
    when v_status = 'success' then 'Measured objective evidence indicates the recommendation helped the target objective.'
    when v_status = 'failure' and v_effect = 'hurt' then 'Measured objective evidence indicates the recommendation hurt or moved against the target objective.'
    when v_status = 'failure' and v_contradicted then 'Later canonical intelligence/research contradicts the recommendation thesis; objective impact is not inferred.'
    when v_status = 'no_benefit' then 'Measured evidence found no measurable benefit to the target objective.'
    else 'No objective evidence currently establishes recommendation quality.'
  end;

  select coalesce(jsonb_agg(jsonb_build_object(
      'evidenceKind', e->>'evidence_kind', 'sourceTable', e->>'source_table',
      'sourceId', e->>'source_id', 'direction', e->>'direction',
      'measuredDelta', e->'measured_delta', 'unit', e->>'unit'
    ) order by e->>'evidence_kind', e->>'source_table', e->>'source_id'), '[]'::jsonb)
  into v_measured_signals
  from jsonb_array_elements(v_canonical_evidence) e
  where coalesce((e->>'measurable')::boolean, false);

  v_fingerprint := encode(digest(concat_ws('|',
    'caye-recommendation-outcome-v2', v_rec.id::text, p_decision_id::text,
    v_rec.fingerprint, v_canonical_evidence::text
  ), 'sha256'), 'hex');

  insert into public.caye_recommendation_outcomes (
    recommendation_id, decision_id, scope, workspace_id, goal_id,
    outcome_status, objective_effect, was_followed, observed_outcome,
    actual_impact, expected_vs_actual, confidence_at_recommendation,
    contradicted_by_later_evidence, evidence_conflict, evaluator_provenance,
    fingerprint, evaluated_at, updated_at
  ) values (
    v_rec.id, v_decision.id, v_rec.scope, v_rec.workspace_id, v_rec.goal_id,
    v_status, v_effect, v_followed, v_observed,
    jsonb_build_object('measuredSignals', v_measured_signals),
    jsonb_build_object('expectedImpact', v_rec.expected_impact,
      'actualOutcomeStatus', v_status, 'actualObjectiveEffect', v_effect,
      'measuredSignals', v_measured_signals),
    v_rec.confidence, v_contradicted, v_conflict, p_evaluator_provenance,
    v_fingerprint, coalesce(p_evaluated_at, now()), now()
  )
  on conflict (fingerprint) do update set
    evaluator_provenance = public.caye_recommendation_outcomes.evaluator_provenance,
    evaluated_at = public.caye_recommendation_outcomes.evaluated_at,
    updated_at = public.caye_recommendation_outcomes.updated_at
  returning * into v_row;

  for v_e in select value from jsonb_array_elements(v_canonical_evidence) loop
    insert into public.caye_recommendation_outcome_evidence (
      outcome_id, evidence_kind, source_table, source_id, observed_at,
      direction, measurable, measured_delta, unit, followed, provenance
    ) values (
      v_row.id, v_e->>'evidence_kind', btrim(v_e->>'source_table'), btrim(v_e->>'source_id'),
      coalesce(nullif(v_e->>'observed_at','')::timestamptz, coalesce(p_evaluated_at, now())),
      coalesce(v_e->>'direction','unknown'), coalesce((v_e->>'measurable')::boolean, false),
      nullif(v_e->>'measured_delta','')::numeric, nullif(btrim(coalesce(v_e->>'unit','')),''),
      case when v_e ? 'followed' then (v_e->>'followed')::boolean else null end,
      v_e->'provenance'
    ) on conflict do nothing;
  end loop;
  return v_row;
end;
$$;

create or replace function public.record_caye_recommendation_founder_feedback(
  p_recommendation_id uuid,
  p_decision_id uuid,
  p_outcome_id uuid,
  p_workspace_id uuid,
  p_usefulness text,
  p_timing text,
  p_noisiness text,
  p_feedback text,
  p_provenance jsonb
)
returns public.caye_recommendation_founder_feedback
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec public.caye_recommendations%rowtype;
  v_row public.caye_recommendation_founder_feedback%rowtype;
  v_fingerprint text;
begin
  select * into v_rec from public.caye_recommendations where id = p_recommendation_id for share;
  if not found then raise exception 'founder feedback recommendation not found'; end if;
  if v_rec.workspace_id is distinct from p_workspace_id then raise exception 'founder feedback workspace mismatch'; end if;
  if p_provenance is null or jsonb_typeof(p_provenance) <> 'object' or p_provenance = '{}'::jsonb then
    raise exception 'founder feedback requires provenance';
  end if;
  if p_usefulness is not null and p_usefulness not in ('useful','not_useful','mixed','unknown') then raise exception 'unsupported usefulness feedback'; end if;
  if p_timing is not null and p_timing not in ('too_early','on_time','too_late','unknown') then raise exception 'unsupported timing feedback'; end if;
  if p_noisiness is not null and p_noisiness not in ('material','too_noisy','unknown') then raise exception 'unsupported noisiness feedback'; end if;

  if p_decision_id is not null and not exists (
    select 1 from public.caye_recommendation_decisions d
    where d.id = p_decision_id and d.recommendation_id = p_recommendation_id
      and d.workspace_id is not distinct from p_workspace_id
  ) then raise exception 'founder feedback decision mismatch'; end if;
  if p_outcome_id is not null and not exists (
    select 1 from public.caye_recommendation_outcomes o
    where o.id = p_outcome_id and o.recommendation_id = p_recommendation_id
      and o.workspace_id is not distinct from p_workspace_id
  ) then raise exception 'founder feedback outcome mismatch'; end if;

  v_fingerprint := encode(digest(concat_ws('|',
    'caye-recommendation-founder-feedback-v1', p_recommendation_id::text,
    coalesce(p_decision_id::text,''), coalesce(p_outcome_id::text,''),
    coalesce(p_usefulness,''), coalesce(p_timing,''), coalesce(p_noisiness,''),
    lower(regexp_replace(btrim(coalesce(p_feedback,'')), '\s+', ' ', 'g'))
  ), 'sha256'), 'hex');

  insert into public.caye_recommendation_founder_feedback (
    recommendation_id, decision_id, outcome_id, workspace_id, usefulness,
    timing, noisiness, feedback, provenance, fingerprint
  ) values (
    p_recommendation_id, p_decision_id, p_outcome_id, p_workspace_id,
    p_usefulness, p_timing, p_noisiness, nullif(btrim(coalesce(p_feedback,'')),''),
    p_provenance, v_fingerprint
  ) on conflict (fingerprint) do nothing returning * into v_row;
  if v_row.id is null then
    select * into v_row from public.caye_recommendation_founder_feedback where fingerprint = v_fingerprint;
  end if;
  return v_row;
end;
$$;

create or replace function public.get_caye_recommendation_calibration(p_workspace_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
with scoped_recs as (
  select r.* from public.caye_recommendations r where r.workspace_id is not distinct from p_workspace_id
), latest_outcomes as (
  select distinct on (o.recommendation_id)
    o.*, r.risk_classification,
    coalesce(nullif(r.provenance->>'domain',''),'unspecified') as domain,
    coalesce(nullif(r.provenance->>'recommendationClass',''), nullif(r.provenance->>'recommendation_class',''), 'unspecified') as recommendation_class
  from public.caye_recommendation_outcomes o join scoped_recs r on r.id = o.recommendation_id
  order by o.recommendation_id, o.evaluated_at desc, o.created_at desc
), evaluated as (
  select * from latest_outcomes where outcome_status <> 'unknown'
), latest_decisions as (
  select distinct on (d.recommendation_id) d.*
  from public.caye_recommendation_decisions d join scoped_recs r on r.id = d.recommendation_id
  order by d.recommendation_id, d.decided_at desc, d.created_at desc
), buckets as (
  select case
    when confidence_at_recommendation <= .2 then '0.0-0.2'
    when confidence_at_recommendation <= .4 then '0.2-0.4'
    when confidence_at_recommendation <= .6 then '0.4-0.6'
    when confidence_at_recommendation <= .8 then '0.6-0.8'
    else '0.8-1.0' end as bucket,
    count(*) as evaluated_count,
    avg(confidence_at_recommendation)::numeric(6,4) as avg_confidence,
    avg(case when outcome_status = 'success' then 1.0 else 0.0 end)::numeric(6,4) as empirical_success_rate
  from evaluated group by 1
), classes as (
  select domain, recommendation_class, risk_classification,
    count(*) as evaluated_count,
    avg(confidence_at_recommendation)::numeric(6,4) as avg_confidence,
    avg(case when outcome_status = 'success' then 1.0 else 0.0 end)::numeric(6,4) as success_rate,
    count(*) filter (where outcome_status in ('failure','no_benefit')) as false_positive_count,
    count(*) filter (where contradicted_by_later_evidence) as contradicted_count
  from evaluated group by domain, recommendation_class, risk_classification
), feedback as (
  select count(*) as feedback_count,
    count(*) filter (where usefulness = 'useful') as useful_count,
    count(*) filter (where usefulness = 'not_useful') as not_useful_count,
    count(*) filter (where timing = 'too_early') as too_early_count,
    count(*) filter (where timing = 'too_late') as too_late_count,
    count(*) filter (where noisiness = 'too_noisy') as too_noisy_count,
    count(*) filter (where noisiness = 'material') as material_count
  from public.caye_recommendation_founder_feedback f join scoped_recs r on r.id = f.recommendation_id
)
select jsonb_build_object(
  'evaluatedCount', (select count(*) from evaluated),
  'unknownCount', (select count(*) from latest_outcomes where outcome_status = 'unknown'),
  'successCount', (select count(*) from evaluated where outcome_status = 'success'),
  'failureCount', (select count(*) from evaluated where outcome_status = 'failure'),
  'noBenefitCount', (select count(*) from evaluated where outcome_status = 'no_benefit'),
  'falsePositiveRate', coalesce((select count(*) filter (where outcome_status in ('failure','no_benefit'))::numeric / nullif(count(*),0) from evaluated), 0),
  'acceptedNoBenefitRate', coalesce((
    select count(*) filter (where e.outcome_status = 'no_benefit')::numeric / nullif(count(*),0)
    from evaluated e join latest_decisions d on d.recommendation_id = e.recommendation_id where d.decision = 'accepted'
  ), 0),
  'contradictedRate', coalesce((select count(*) filter (where contradicted_by_later_evidence)::numeric / nullif(count(*),0) from evaluated), 0),
  'ignoredOrRejectedRate', coalesce((
    select count(*) filter (where decision in ('rejected','deferred'))::numeric
      / nullif(count(*) filter (where decision <> 'cancelled'),0) from latest_decisions
  ), 0),
  'confidenceBuckets', coalesce((select jsonb_agg(jsonb_build_object(
      'bucket', bucket, 'evaluatedCount', evaluated_count, 'avgConfidence', avg_confidence,
      'empiricalSuccessRate', empirical_success_rate,
      'calibrationGap', (avg_confidence - empirical_success_rate)::numeric(6,4)
    ) order by bucket) from buckets), '[]'::jsonb),
  'generationContext', coalesce((select jsonb_agg(jsonb_build_object(
      'domain', domain, 'recommendationClass', recommendation_class, 'riskClassification', risk_classification,
      'evaluatedCount', evaluated_count, 'avgConfidence', avg_confidence, 'successRate', success_rate,
      'overconfidenceGap', (avg_confidence - success_rate)::numeric(6,4),
      'falsePositiveCount', false_positive_count, 'contradictedCount', contradicted_count
    ) order by evaluated_count desc, domain, recommendation_class) from classes), '[]'::jsonb),
  'founderFeedback', (select jsonb_build_object(
      'feedbackCount', feedback_count, 'usefulCount', useful_count,
      'notUsefulCount', not_useful_count, 'tooEarlyCount', too_early_count,
      'tooLateCount', too_late_count, 'tooNoisyCount', too_noisy_count,
      'materialCount', material_count
    ) from feedback)
);
$$;

revoke all on function public.evaluate_caye_recommendation_outcome(uuid, uuid, uuid, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.evaluate_caye_recommendation_outcome(uuid, uuid, uuid, jsonb, jsonb, timestamptz) to service_role;
revoke all on function public.record_caye_recommendation_founder_feedback(uuid, uuid, uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_caye_recommendation_founder_feedback(uuid, uuid, uuid, uuid, text, text, text, text, jsonb) to service_role;
revoke all on function public.get_caye_recommendation_calibration(uuid) from public, anon, authenticated;
grant execute on function public.get_caye_recommendation_calibration(uuid) to service_role;

comment on table public.caye_recommendation_outcomes is
  'Objective recommendation evaluations linked to canonical decisions. Acceptance/rejection never determines quality.';
comment on table public.caye_recommendation_founder_feedback is
  'Explicit founder usefulness/timing/noise feedback, deliberately separate from objective outcome evidence.';
comment on function public.get_caye_recommendation_calibration(uuid) is
  'Deterministic recommendation calibration aggregates. Unknown outcomes are excluded from quality denominators; authority is never modified.';
