-- Grounded write paths for the canonical Caye Intelligence substrate.
--
-- This migration deliberately extends intelligence_items/intelligence_relations
-- instead of creating a parallel intelligence model. Relations are formed only
-- between explicit endpoints, and every relation/confidence revision carries
-- canonical research-claim evidence that can be revisited later.

create table if not exists public.intelligence_relation_claims (
  relation_id uuid not null references public.intelligence_relations(id) on delete cascade,
  claim_id uuid not null references public.research_claims(id) on delete cascade,
  role text not null default 'supports' check (role in ('supports','contradicts','context')),
  created_at timestamptz not null default now(),
  primary key (relation_id, claim_id, role)
);

create index if not exists intelligence_relation_claims_claim_idx
  on public.intelligence_relation_claims(claim_id, relation_id);

create table if not exists public.intelligence_belief_revisions (
  id uuid primary key default gen_random_uuid(),
  intelligence_item_id uuid not null references public.intelligence_items(id) on delete cascade,
  prior_confidence numeric(4,3) check (prior_confidence is null or prior_confidence between 0 and 1),
  revised_confidence numeric(4,3) not null check (revised_confidence between 0 and 1),
  rationale text not null check (length(btrim(rationale)) > 0),
  evidence_role text not null check (evidence_role in ('supports','contradicts','context')),
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.intelligence_belief_revision_claims (
  revision_id uuid not null references public.intelligence_belief_revisions(id) on delete cascade,
  claim_id uuid not null references public.research_claims(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (revision_id, claim_id)
);

create index if not exists intelligence_belief_revisions_item_idx
  on public.intelligence_belief_revisions(intelligence_item_id, created_at desc);
create index if not exists intelligence_belief_revision_claims_claim_idx
  on public.intelligence_belief_revision_claims(claim_id, revision_id);

alter table public.intelligence_relation_claims enable row level security;
alter table public.intelligence_belief_revisions enable row level security;
alter table public.intelligence_belief_revision_claims enable row level security;

revoke all on public.intelligence_relation_claims,
              public.intelligence_belief_revisions,
              public.intelligence_belief_revision_claims
  from anon, authenticated;

-- Explicit-endpoint relation writer. It never scans intelligence_items for
-- candidate pairs: candidate formation belongs to bounded synthesis code, while
-- this function only commits a relation already selected by that code.
create or replace function public.upsert_grounded_intelligence_relation(
  p_from_item_id uuid,
  p_to_item_id uuid,
  p_relation_type text,
  p_confidence numeric,
  p_evidence_claim_ids uuid[],
  p_provenance jsonb default '{}'::jsonb
)
returns public.intelligence_relations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from public.intelligence_items%rowtype;
  v_to public.intelligence_items%rowtype;
  v_relation public.intelligence_relations%rowtype;
  v_claim_id uuid;
begin
  if p_from_item_id is null or p_to_item_id is null or p_from_item_id = p_to_item_id then
    raise exception 'relation requires two distinct intelligence item ids';
  end if;

  if p_relation_type not in ('related','corroborates','contradicts','supersedes','causes','implicates') then
    raise exception 'unsupported intelligence relation type: %', p_relation_type;
  end if;

  if p_confidence is not null and (p_confidence < 0 or p_confidence > 1) then
    raise exception 'relation confidence must be between 0 and 1';
  end if;

  if coalesce(cardinality(p_evidence_claim_ids), 0) = 0 then
    raise exception 'grounded relation requires research claim evidence';
  end if;

  select * into v_from from public.intelligence_items where id = p_from_item_id for share;
  if not found then raise exception 'from intelligence item not found'; end if;

  select * into v_to from public.intelligence_items where id = p_to_item_id for share;
  if not found then raise exception 'to intelligence item not found'; end if;

  if v_from.scope is distinct from v_to.scope
     or v_from.workspace_id is distinct from v_to.workspace_id then
    raise exception 'intelligence relation endpoints must share scope and workspace';
  end if;

  -- Reject dangling/noncanonical evidence before mutating graph state.
  if exists (
    select 1
    from unnest(p_evidence_claim_ids) as evidence(claim_id)
    left join public.research_claims c on c.id = evidence.claim_id
    where c.id is null
  ) then
    raise exception 'relation evidence contains an unknown research claim';
  end if;

  -- A relation cannot borrow an arbitrary valid claim merely because that claim
  -- exists. At least one endpoint must already be grounded by every supplied
  -- claim through the canonical intelligence_item_claims evidence graph.
  if exists (
    select 1
    from unnest(p_evidence_claim_ids) as evidence(claim_id)
    where not exists (
      select 1
      from public.intelligence_item_claims item_claim
      where item_claim.claim_id = evidence.claim_id
        and item_claim.intelligence_item_id in (p_from_item_id, p_to_item_id)
    )
  ) then
    raise exception 'relation evidence must already ground at least one endpoint';
  end if;

  insert into public.intelligence_relations (
    from_item_id, to_item_id, relation_type, status, confidence, provenance
  ) values (
    p_from_item_id,
    p_to_item_id,
    p_relation_type,
    'active',
    p_confidence,
    coalesce(p_provenance, '{}'::jsonb)
  )
  on conflict (from_item_id, to_item_id, relation_type) do update set
    status = 'active',
    confidence = excluded.confidence,
    provenance = case
      when public.intelligence_relations.provenance = '{}'::jsonb then excluded.provenance
      when excluded.provenance = '{}'::jsonb then public.intelligence_relations.provenance
      else public.intelligence_relations.provenance || excluded.provenance
    end,
    resolved_at = null
  returning * into v_relation;

  foreach v_claim_id in array p_evidence_claim_ids loop
    insert into public.intelligence_relation_claims(relation_id, claim_id, role)
    values (v_relation.id, v_claim_id, 'supports')
    on conflict do nothing;
  end loop;

  return v_relation;
end;
$$;

revoke all on function public.upsert_grounded_intelligence_relation(uuid, uuid, text, numeric, uuid[], jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_grounded_intelligence_relation(uuid, uuid, text, numeric, uuid[], jsonb)
  to service_role;

-- Atomic belief revision. The current belief stays canonical on
-- intelligence_items; this append-only ledger records how and why confidence
-- changed and links the evidence that justified the change.
create or replace function public.revise_intelligence_belief_confidence(
  p_intelligence_item_id uuid,
  p_revised_confidence numeric,
  p_rationale text,
  p_evidence_claim_ids uuid[],
  p_evidence_role text default 'context',
  p_provenance jsonb default '{}'::jsonb
)
returns public.intelligence_belief_revisions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.intelligence_items%rowtype;
  v_revision public.intelligence_belief_revisions%rowtype;
  v_claim_id uuid;
begin
  if p_revised_confidence is null or p_revised_confidence < 0 or p_revised_confidence > 1 then
    raise exception 'revised confidence must be between 0 and 1';
  end if;

  if length(btrim(coalesce(p_rationale, ''))) = 0 then
    raise exception 'belief revision requires a rationale';
  end if;

  if p_evidence_role not in ('supports','contradicts','context') then
    raise exception 'unsupported evidence role: %', p_evidence_role;
  end if;

  if coalesce(cardinality(p_evidence_claim_ids), 0) = 0 then
    raise exception 'belief revision requires research claim evidence';
  end if;

  select * into v_item
  from public.intelligence_items
  where id = p_intelligence_item_id
  for update;

  if not found then raise exception 'intelligence item not found'; end if;

  if exists (
    select 1
    from unnest(p_evidence_claim_ids) as evidence(claim_id)
    left join public.research_claims c on c.id = evidence.claim_id
    where c.id is null
  ) then
    raise exception 'belief revision evidence contains an unknown research claim';
  end if;

  insert into public.intelligence_belief_revisions (
    intelligence_item_id,
    prior_confidence,
    revised_confidence,
    rationale,
    evidence_role,
    provenance
  ) values (
    v_item.id,
    v_item.confidence,
    p_revised_confidence,
    btrim(p_rationale),
    p_evidence_role,
    coalesce(p_provenance, '{}'::jsonb)
  ) returning * into v_revision;

  foreach v_claim_id in array p_evidence_claim_ids loop
    -- Keep the canonical item-to-claim evidence graph current as belief state
    -- changes, while retaining the exact evidence set on the revision ledger.
    insert into public.intelligence_item_claims(intelligence_item_id, claim_id, role)
    values (v_item.id, v_claim_id, p_evidence_role)
    on conflict do nothing;

    insert into public.intelligence_belief_revision_claims(revision_id, claim_id)
    values (v_revision.id, v_claim_id)
    on conflict do nothing;
  end loop;

  update public.intelligence_items
  set confidence = p_revised_confidence,
      updated_at = now()
  where id = v_item.id;

  return v_revision;
end;
$$;

revoke all on function public.revise_intelligence_belief_confidence(uuid, numeric, text, uuid[], text, jsonb)
  from public, anon, authenticated;
grant execute on function public.revise_intelligence_belief_confidence(uuid, numeric, text, uuid[], text, jsonb)
  to service_role;

comment on table public.intelligence_relation_claims is
  'Canonical research-claim evidence for typed intelligence relations. Relation formation is explicit and bounded; this table makes graph edges auditable.';
comment on table public.intelligence_belief_revisions is
  'Append-only audit ledger for evidence-backed confidence changes to canonical intelligence items.';
comment on table public.intelligence_belief_revision_claims is
  'Exact research claims used for a belief confidence revision.';
