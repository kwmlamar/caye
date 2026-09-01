-- Canonical evidence-backed recommendation substrate.
--
-- A recommendation is not a free-floating model suggestion. It is a durable,
-- service-created proposed course of action rooted in canonical intelligence,
-- an active canonical goal, and research claims that already exist in the
-- intelligence provenance graph. Execution/decision state is intentionally out
-- of scope; Agent 2 owns that layer.

create table if not exists public.caye_recommendations (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('operator','workspace')),
  workspace_id uuid references public.customers(id) on delete cascade,
  goal_id uuid not null references public.caye_goals(id) on delete restrict,
  title text not null check (length(btrim(title)) > 0),
  recommendation text not null check (length(btrim(recommendation)) > 0),
  rationale text not null check (length(btrim(rationale)) > 0),
  status text not null default 'proposed'
    check (status in ('proposed','accepted','rejected','deferred','withdrawn','superseded')),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  expected_impact text not null check (length(btrim(expected_impact)) > 0),
  urgency text not null check (urgency in ('low','medium','high','immediate')),
  reversibility text not null check (reversibility in ('easy','moderate','hard','irreversible')),
  risk_classification text not null check (risk_classification in ('low','medium','high','critical')),
  required_authority jsonb not null,
  fingerprint text not null unique,
  provenance jsonb not null default '{}'::jsonb,
  superseded_by uuid references public.caye_recommendations(id) on delete set null,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint caye_recommendations_scope_workspace_pairing check (
    (scope = 'workspace' and workspace_id is not null) or
    (scope = 'operator' and workspace_id is null)
  ),
  constraint caye_recommendations_superseded_shape check (
    (status = 'superseded' and superseded_at is not null) or
    (status <> 'superseded')
  )
);

create table if not exists public.caye_recommendation_intelligence (
  recommendation_id uuid not null references public.caye_recommendations(id) on delete cascade,
  intelligence_item_id uuid not null references public.intelligence_items(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (recommendation_id, intelligence_item_id)
);

create table if not exists public.caye_recommendation_belief_revisions (
  recommendation_id uuid not null references public.caye_recommendations(id) on delete cascade,
  belief_revision_id uuid not null references public.intelligence_belief_revisions(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (recommendation_id, belief_revision_id)
);

create table if not exists public.caye_recommendation_claims (
  recommendation_id uuid not null references public.caye_recommendations(id) on delete cascade,
  claim_id uuid not null references public.research_claims(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (recommendation_id, claim_id)
);

create index if not exists caye_recommendations_goal_status_idx
  on public.caye_recommendations(goal_id, status, urgency, updated_at desc);
create index if not exists caye_recommendations_workspace_status_idx
  on public.caye_recommendations(workspace_id, status, updated_at desc)
  where scope = 'workspace';
create index if not exists caye_recommendation_intelligence_item_idx
  on public.caye_recommendation_intelligence(intelligence_item_id, recommendation_id);
create index if not exists caye_recommendation_claims_claim_idx
  on public.caye_recommendation_claims(claim_id, recommendation_id);

alter table public.caye_recommendations enable row level security;
alter table public.caye_recommendation_intelligence enable row level security;
alter table public.caye_recommendation_belief_revisions enable row level security;
alter table public.caye_recommendation_claims enable row level security;

revoke all on public.caye_recommendations,
              public.caye_recommendation_intelligence,
              public.caye_recommendation_belief_revisions,
              public.caye_recommendation_claims
  from anon, authenticated;

create or replace function public.upsert_grounded_caye_recommendation(
  p_goal_id uuid,
  p_title text,
  p_recommendation text,
  p_rationale text,
  p_confidence numeric,
  p_expected_impact text,
  p_urgency text,
  p_reversibility text,
  p_risk_classification text,
  p_required_authority jsonb,
  p_intelligence_item_ids uuid[],
  p_belief_revision_ids uuid[] default '{}'::uuid[],
  p_evidence_claim_ids uuid[] default '{}'::uuid[],
  p_provenance jsonb default '{}'::jsonb
)
returns public.caye_recommendations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_goal public.caye_goals%rowtype;
  v_row public.caye_recommendations%rowtype;
  v_item_id uuid;
  v_revision_id uuid;
  v_claim_id uuid;
  v_item_ids uuid[];
  v_revision_ids uuid[];
  v_claim_ids uuid[];
  v_confidence_ceiling numeric;
  v_fingerprint text;
begin
  if p_goal_id is null then raise exception 'recommendation requires a canonical goal'; end if;
  if length(btrim(coalesce(p_title,''))) = 0
     or length(btrim(coalesce(p_recommendation,''))) = 0
     or length(btrim(coalesce(p_rationale,''))) = 0
     or length(btrim(coalesce(p_expected_impact,''))) = 0 then
    raise exception 'recommendation title, action, rationale, and expected impact are required';
  end if;
  if p_confidence is null or p_confidence < 0 or p_confidence > 1 then
    raise exception 'recommendation confidence must be between 0 and 1';
  end if;
  if p_urgency not in ('low','medium','high','immediate') then raise exception 'unsupported recommendation urgency'; end if;
  if p_reversibility not in ('easy','moderate','hard','irreversible') then raise exception 'unsupported recommendation reversibility'; end if;
  if p_risk_classification not in ('low','medium','high','critical') then raise exception 'unsupported recommendation risk classification'; end if;
  if p_required_authority is null or jsonb_typeof(p_required_authority) <> 'object' then
    raise exception 'recommendation requires resolved authority metadata';
  end if;

  select * into v_goal from public.caye_goals where id = p_goal_id for share;
  if not found then raise exception 'recommendation goal not found'; end if;
  if v_goal.status <> 'active' or v_goal.superseded_at is not null then
    raise exception 'recommendation target must be an active non-superseded canonical goal';
  end if;

  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_item_ids
  from unnest(coalesce(p_intelligence_item_ids, '{}'::uuid[])) as u(x);
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_revision_ids
  from unnest(coalesce(p_belief_revision_ids, '{}'::uuid[])) as u(x);
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_claim_ids
  from unnest(coalesce(p_evidence_claim_ids, '{}'::uuid[])) as u(x);

  if cardinality(v_item_ids) = 0 then
    raise exception 'recommendation requires originating intelligence';
  end if;
  if cardinality(v_claim_ids) = 0 then
    raise exception 'recommendation requires canonical research claim evidence';
  end if;

  if exists (
    select 1 from unnest(v_item_ids) u(id)
    left join public.intelligence_items i on i.id = u.id
    where i.id is null
  ) then raise exception 'recommendation references unknown intelligence'; end if;

  -- Global intelligence may inform any scoped goal. Non-global intelligence
  -- must match the recommendation/goal scope exactly, preventing workspace
  -- leakage while still allowing globally researched facts to affect a goal.
  if exists (
    select 1
    from public.intelligence_items i
    where i.id = any(v_item_ids)
      and i.scope <> 'global'
      and (
        i.scope is distinct from v_goal.scope
        or i.workspace_id is distinct from v_goal.workspace_id
      )
  ) then
    raise exception 'recommendation intelligence must be global or share goal scope and workspace';
  end if;

  if exists (
    select 1 from public.intelligence_items i
    where i.id = any(v_item_ids)
      and i.status not in ('current','contested')
  ) then
    raise exception 'recommendation intelligence must be current or contested';
  end if;

  -- Reuse the existing canonical intelligence -> goal bridge. At least one
  -- originating item must already have an evidence-backed impact on this goal.
  if not exists (
    select 1 from public.intelligence_goal_impacts gi
    where gi.goal_id = p_goal_id
      and gi.intelligence_item_id = any(v_item_ids)
  ) then
    raise exception 'recommendation requires a canonical intelligence goal impact';
  end if;

  if exists (
    select 1
    from unnest(v_revision_ids) u(id)
    left join public.intelligence_belief_revisions r on r.id = u.id
    where r.id is null or not (r.intelligence_item_id = any(v_item_ids))
  ) then
    raise exception 'recommendation belief revisions must belong to originating intelligence';
  end if;

  if exists (
    select 1 from unnest(v_claim_ids) u(id)
    left join public.research_claims c on c.id = u.id
    where c.id is null
  ) then raise exception 'recommendation evidence contains an unknown research claim'; end if;

  -- Founder wording/model prose is never evidence. Every supplied claim must
  -- already ground an originating intelligence item or one of its supplied
  -- belief revisions through the canonical provenance edges.
  if exists (
    select 1
    from unnest(v_claim_ids) u(id)
    where not exists (
      select 1 from public.intelligence_item_claims ic
      where ic.claim_id = u.id and ic.intelligence_item_id = any(v_item_ids)
    )
    and not exists (
      select 1
      from public.intelligence_belief_revision_claims rc
      where rc.claim_id = u.id and rc.revision_id = any(v_revision_ids)
    )
  ) then
    raise exception 'recommendation evidence must already exist in canonical intelligence provenance';
  end if;

  -- Do not flatten uncertainty upward. The recommendation cannot claim more
  -- confidence than the weakest non-null originating belief/revision it cites.
  select min(bound) into v_confidence_ceiling
  from (
    select i.confidence as bound from public.intelligence_items i
      where i.id = any(v_item_ids) and i.confidence is not null
    union all
    select r.revised_confidence as bound from public.intelligence_belief_revisions r
      where r.id = any(v_revision_ids)
  ) bounds;
  if v_confidence_ceiling is not null and p_confidence > v_confidence_ceiling then
    raise exception 'recommendation confidence exceeds evidence-supported bound';
  end if;

  v_fingerprint := encode(digest(
    concat_ws('|',
      'caye-recommendation-v1',
      v_goal.scope,
      coalesce(v_goal.workspace_id::text, ''),
      p_goal_id::text,
      lower(regexp_replace(btrim(p_recommendation), '\\s+', ' ', 'g')),
      array_to_string(v_item_ids, ','),
      array_to_string(v_revision_ids, ','),
      array_to_string(v_claim_ids, ',')
    ), 'sha256'
  ), 'hex');

  insert into public.caye_recommendations (
    scope, workspace_id, goal_id, title, recommendation, rationale, status,
    confidence, expected_impact, urgency, reversibility, risk_classification,
    required_authority, fingerprint, provenance, updated_at
  ) values (
    v_goal.scope, v_goal.workspace_id, p_goal_id, btrim(p_title),
    btrim(p_recommendation), btrim(p_rationale), 'proposed', p_confidence,
    btrim(p_expected_impact), p_urgency, p_reversibility, p_risk_classification,
    p_required_authority, v_fingerprint, coalesce(p_provenance, '{}'::jsonb), now()
  )
  on conflict (fingerprint) do update set
    title = excluded.title,
    recommendation = excluded.recommendation,
    rationale = excluded.rationale,
    confidence = excluded.confidence,
    expected_impact = excluded.expected_impact,
    urgency = excluded.urgency,
    reversibility = excluded.reversibility,
    risk_classification = excluded.risk_classification,
    required_authority = excluded.required_authority,
    provenance = case
      when public.caye_recommendations.provenance = '{}'::jsonb then excluded.provenance
      when excluded.provenance = '{}'::jsonb then public.caye_recommendations.provenance
      else public.caye_recommendations.provenance || excluded.provenance
    end,
    updated_at = now()
  returning * into v_row;

  foreach v_item_id in array v_item_ids loop
    insert into public.caye_recommendation_intelligence(recommendation_id, intelligence_item_id)
    values (v_row.id, v_item_id) on conflict do nothing;
  end loop;
  foreach v_revision_id in array v_revision_ids loop
    insert into public.caye_recommendation_belief_revisions(recommendation_id, belief_revision_id)
    values (v_row.id, v_revision_id) on conflict do nothing;
  end loop;
  foreach v_claim_id in array v_claim_ids loop
    insert into public.caye_recommendation_claims(recommendation_id, claim_id)
    values (v_row.id, v_claim_id) on conflict do nothing;
  end loop;

  return v_row;
end;
$$;

revoke all on function public.upsert_grounded_caye_recommendation(
  uuid, text, text, text, numeric, text, text, text, text, jsonb, uuid[], uuid[], uuid[], jsonb
) from public, anon, authenticated;
grant execute on function public.upsert_grounded_caye_recommendation(
  uuid, text, text, text, numeric, text, text, text, text, jsonb, uuid[], uuid[], uuid[], jsonb
) to service_role;

comment on table public.caye_recommendations is
  'Canonical proposed courses of action rooted in durable intelligence, active goals, and canonical research evidence. Contains recommendation state only; execution/decision state belongs elsewhere.';
comment on function public.upsert_grounded_caye_recommendation(
  uuid, text, text, text, numeric, text, text, text, text, jsonb, uuid[], uuid[], uuid[], jsonb
) is 'Service-role-only idempotent writer for canonical evidence-backed recommendations.';
