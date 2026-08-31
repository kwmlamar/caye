-- Narrow bridge between canonical intelligence and canonical founder goals.
-- This is intentionally not a generic graph: it exists only for evidence-backed
-- objective impact discovered by cross-domain synthesis.

create table if not exists public.intelligence_goal_impacts (
  intelligence_item_id uuid not null references public.intelligence_items(id) on delete cascade,
  goal_id uuid not null references public.caye_goals(id) on delete cascade,
  mechanism text not null check (length(trim(mechanism)) > 0),
  impact text not null check (length(trim(impact)) > 0),
  confidence numeric not null check (confidence between 0 and 1),
  evidence_claim_ids uuid[] not null check (cardinality(evidence_claim_ids) > 0),
  synthesis_fingerprint text not null,
  attention_required boolean not null default false,
  attention_fingerprint text,
  attention_changed_at timestamptz,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (intelligence_item_id, goal_id)
);

create index if not exists intelligence_goal_impacts_goal_attention_idx
  on public.intelligence_goal_impacts(goal_id, attention_required, attention_changed_at desc)
  where attention_required = true;

create or replace function public.upsert_grounded_intelligence_goal_impact(
  p_intelligence_item_id uuid,
  p_goal_id uuid,
  p_mechanism text,
  p_impact text,
  p_confidence numeric,
  p_evidence_claim_ids uuid[],
  p_synthesis_fingerprint text,
  p_provenance jsonb default '{}'::jsonb
) returns public.intelligence_goal_impacts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.intelligence_goal_impacts;
  v_expected int;
  v_found int;
begin
  if p_intelligence_item_id is null or p_goal_id is null then
    raise exception 'intelligence item and goal are required';
  end if;
  if length(trim(coalesce(p_mechanism, ''))) = 0 or length(trim(coalesce(p_impact, ''))) = 0 then
    raise exception 'objective impact requires an explicit mechanism and impact';
  end if;
  if p_confidence is null or p_confidence < 0 or p_confidence > 1 then
    raise exception 'confidence must be between 0 and 1';
  end if;

  select count(distinct claim_id) into v_expected
  from unnest(coalesce(p_evidence_claim_ids, '{}'::uuid[])) claim_id;
  if v_expected = 0 then
    raise exception 'objective impact requires claim evidence';
  end if;

  select count(distinct c.id) into v_found
  from research_claims c
  where c.id = any(p_evidence_claim_ids);
  if v_found <> v_expected then
    raise exception 'objective impact cites unknown research claim evidence';
  end if;

  if not exists (
    select 1 from caye_goals g
    where g.id = p_goal_id
      and g.status = 'active'
      and g.superseded_at is null
  ) then
    raise exception 'objective impact target must be an active canonical goal';
  end if;

  insert into intelligence_goal_impacts (
    intelligence_item_id, goal_id, mechanism, impact, confidence,
    evidence_claim_ids, synthesis_fingerprint, provenance, updated_at
  ) values (
    p_intelligence_item_id, p_goal_id, trim(p_mechanism), trim(p_impact), p_confidence,
    (select array_agg(distinct claim_id order by claim_id) from unnest(p_evidence_claim_ids) claim_id),
    p_synthesis_fingerprint, coalesce(p_provenance, '{}'::jsonb), now()
  )
  on conflict (intelligence_item_id, goal_id) do update set
    mechanism = excluded.mechanism,
    impact = excluded.impact,
    confidence = excluded.confidence,
    evidence_claim_ids = excluded.evidence_claim_ids,
    synthesis_fingerprint = excluded.synthesis_fingerprint,
    provenance = intelligence_goal_impacts.provenance || excluded.provenance,
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.upsert_grounded_intelligence_goal_impact(uuid, uuid, text, text, numeric, uuid[], text, jsonb) from public;
grant execute on function public.upsert_grounded_intelligence_goal_impact(uuid, uuid, text, text, numeric, uuid[], text, jsonb) to service_role;
