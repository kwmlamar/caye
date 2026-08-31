-- Markets, Business & Capital Intelligence V1.
-- Extends the canonical research runtime. Research may be autonomous; live
-- trading, brokerage mutations, capital deployment, and financial commitments
-- are intentionally absent from this schema and subsystem.

create table if not exists public.market_intelligence_theses (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.research_programs(id) on delete cascade,
  originating_question_id uuid references public.research_questions(id) on delete set null,
  claim text not null check (btrim(claim) <> ''),
  status text not null default 'active'
    check (status in ('active','contested','invalidated','superseded')),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  catalysts jsonb not null default '[]'::jsonb check (jsonb_typeof(catalysts) = 'array'),
  invalidation_conditions jsonb not null default '[]'::jsonb check (jsonb_typeof(invalidation_conditions) = 'array'),
  related_companies jsonb not null default '[]'::jsonb check (jsonb_typeof(related_companies) = 'array'),
  related_sectors jsonb not null default '[]'::jsonb check (jsonb_typeof(related_sectors) = 'array'),
  related_technologies jsonb not null default '[]'::jsonb check (jsonb_typeof(related_technologies) = 'array'),
  expected_horizon text,
  implications jsonb not null default '[]'::jsonb check (jsonb_typeof(implications) = 'array'),
  last_reviewed_at timestamptz,
  next_review_trigger text,
  superseded_by_thesis_id uuid references public.market_intelligence_theses(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_thesis_supersession_consistency check (
    (status = 'superseded' and superseded_by_thesis_id is not null)
    or (status <> 'superseded' and superseded_by_thesis_id is null)
  )
);

create table if not exists public.market_thesis_evidence_events (
  id bigint generated always as identity primary key,
  thesis_id uuid not null references public.market_intelligence_theses(id) on delete cascade,
  research_claim_id uuid not null references public.research_claims(id) on delete restrict,
  effect text not null check (effect in ('strengthen','weaken','contradict','invalidate','supersede')),
  prior_confidence numeric(4,3) not null check (prior_confidence between 0 and 1),
  resulting_confidence numeric(4,3) not null check (resulting_confidence between 0 and 1),
  prior_status text not null check (prior_status in ('active','contested')),
  resulting_status text not null check (resulting_status in ('active','contested','invalidated','superseded')),
  reason text not null check (btrim(reason) <> ''),
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(thesis_id, research_claim_id, effect)
);

comment on table public.market_thesis_evidence_events is
  'Append-only confidence history and evidence effects. Supporting evidence is strengthen/supersede; counter-evidence is weaken/contradict/invalidate. Evidence always points to canonical research_claims.';

create table if not exists public.market_intelligence_opportunities (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.research_programs(id) on delete cascade,
  opportunity_kind text not null check (opportunity_kind in (
    'input_cost_decline','regulatory_demand','demand_supply_gap','capability_new_category','market_mismatch'
  )),
  title text not null check (btrim(title) <> ''),
  thesis text not null check (btrim(thesis) <> ''),
  mechanism text not null check (btrim(mechanism) <> ''),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  evidence_claim_ids uuid[] not null check (cardinality(evidence_claim_ids) > 0),
  assumptions jsonb not null default '[]'::jsonb check (jsonb_typeof(assumptions) = 'array'),
  risks jsonb not null default '[]'::jsonb check (jsonb_typeof(risks) = 'array'),
  invalidation_conditions jsonb not null default '[]'::jsonb check (jsonb_typeof(invalidation_conditions) = 'array'),
  related_entities jsonb not null default '[]'::jsonb check (jsonb_typeof(related_entities) = 'array'),
  expected_horizon text,
  status text not null default 'open' check (status in ('open','watching','invalidated','realized','archived')),
  next_review_trigger text,
  detected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists market_intelligence_theses_program_status_idx
  on public.market_intelligence_theses(program_id, status, updated_at desc);
create index if not exists market_thesis_evidence_events_thesis_idx
  on public.market_thesis_evidence_events(thesis_id, observed_at desc);
create index if not exists market_intelligence_opportunities_program_status_idx
  on public.market_intelligence_opportunities(program_id, status, detected_at desc);

alter table public.market_intelligence_theses enable row level security;
alter table public.market_thesis_evidence_events enable row level security;
alter table public.market_intelligence_opportunities enable row level security;
revoke all on public.market_intelligence_theses, public.market_thesis_evidence_events, public.market_intelligence_opportunities from anon, authenticated;

create or replace function public.apply_market_thesis_evidence(
  p_thesis_id uuid,
  p_research_claim_id uuid,
  p_effect text,
  p_confidence_delta numeric,
  p_reason text,
  p_observed_at timestamptz default now(),
  p_superseded_by_thesis_id uuid default null
) returns public.market_intelligence_theses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thesis public.market_intelligence_theses%rowtype;
  v_claim public.research_claims%rowtype;
  v_new_confidence numeric(4,3);
  v_new_status text;
begin
  if p_effect not in ('strengthen','weaken','contradict','invalidate','supersede') then
    raise exception 'invalid thesis evidence effect';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'thesis evidence reason is required';
  end if;

  select * into v_thesis from public.market_intelligence_theses where id = p_thesis_id for update;
  if not found then raise exception 'market thesis not found'; end if;
  if v_thesis.status in ('invalidated','superseded') then
    raise exception 'terminal thesis cannot accept evidence updates';
  end if;

  select * into v_claim from public.research_claims where id = p_research_claim_id;
  if not found then raise exception 'canonical research claim not found'; end if;
  if not exists (
    select 1 from public.research_questions q
    where q.id = v_claim.question_id and q.program_id = v_thesis.program_id
  ) then
    raise exception 'evidence claim must belong to thesis research program';
  end if;

  if p_effect = 'strengthen' then
    v_new_confidence := least(1, v_thesis.confidence + abs(coalesce(p_confidence_delta, .05)));
    v_new_status := case when v_thesis.status = 'contested' then 'active' else v_thesis.status end;
  elsif p_effect = 'weaken' then
    v_new_confidence := greatest(0, v_thesis.confidence - abs(coalesce(p_confidence_delta, .05)));
    v_new_status := v_thesis.status;
  elsif p_effect = 'contradict' then
    v_new_confidence := greatest(0, v_thesis.confidence - abs(coalesce(p_confidence_delta, .15)));
    v_new_status := 'contested';
  elsif p_effect = 'invalidate' then
    v_new_confidence := 0;
    v_new_status := 'invalidated';
  else
    if p_superseded_by_thesis_id is null or p_superseded_by_thesis_id = p_thesis_id then
      raise exception 'valid superseding thesis is required';
    end if;
    if not exists (
      select 1 from public.market_intelligence_theses
      where id = p_superseded_by_thesis_id and program_id = v_thesis.program_id
    ) then
      raise exception 'superseding thesis must exist in same research program';
    end if;
    v_new_confidence := v_thesis.confidence;
    v_new_status := 'superseded';
  end if;

  insert into public.market_thesis_evidence_events(
    thesis_id, research_claim_id, effect, prior_confidence, resulting_confidence,
    prior_status, resulting_status, reason, observed_at
  ) values (
    p_thesis_id, p_research_claim_id, p_effect, v_thesis.confidence, v_new_confidence,
    v_thesis.status, v_new_status, p_reason, coalesce(p_observed_at, now())
  );

  update public.market_intelligence_theses
  set confidence = v_new_confidence,
      status = v_new_status,
      last_reviewed_at = coalesce(p_observed_at, now()),
      superseded_by_thesis_id = case when p_effect = 'supersede' then p_superseded_by_thesis_id else null end,
      updated_at = now()
  where id = p_thesis_id
  returning * into v_thesis;

  return v_thesis;
end
$$;

revoke all on function public.apply_market_thesis_evidence(uuid,uuid,text,numeric,text,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.apply_market_thesis_evidence(uuid,uuid,text,numeric,text,timestamptz,uuid) to service_role;

-- Read views make support/counter evidence explicit without duplicating the
-- canonical research evidence substrate.
create or replace view public.market_thesis_evidence_summary as
select
  t.id as thesis_id,
  coalesce(array_agg(distinct e.research_claim_id) filter (where e.effect in ('strengthen','supersede')), '{}'::uuid[]) as supporting_evidence_claim_ids,
  coalesce(array_agg(distinct e.research_claim_id) filter (where e.effect in ('weaken','contradict','invalidate')), '{}'::uuid[]) as counter_evidence_claim_ids
from public.market_intelligence_theses t
left join public.market_thesis_evidence_events e on e.thesis_id = t.id
group by t.id;

revoke all on public.market_thesis_evidence_summary from anon, authenticated;
