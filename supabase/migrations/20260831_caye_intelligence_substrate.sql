-- Canonical Caye Intelligence substrate. Additive extension of Research Runtime V1.
-- Research sources/claims remain the evidence substrate; intelligence adds durable belief state and typed relations.

alter table public.research_programs
  add column if not exists domain text,
  add column if not exists intelligence_scope text not null default 'operator'
    check (intelligence_scope in ('global','operator','workspace'));

alter table public.research_claims
  add column if not exists epistemic_type text not null default 'source_claim'
    check (epistemic_type in ('observed_source_fact','source_claim','corroborated_claim','inference','prediction','recommendation','unknown')),
  add column if not exists normalized_statement text,
  add column if not exists semantic_key text,
  add column if not exists observed_at timestamptz not null default now();

create index if not exists research_claims_semantic_key_idx on public.research_claims(question_id, semantic_key);
create index if not exists research_claims_current_temporal_idx on public.research_claims(status, valid_until);

create table if not exists public.intelligence_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid null,
  scope text not null check (scope in ('global','operator','workspace')),
  domain text not null,
  topic text not null,
  canonical_claim text not null,
  semantic_key text not null,
  epistemic_type text not null check (epistemic_type in ('observed_source_fact','source_claim','corroborated_claim','inference','prediction','recommendation','unknown')),
  confidence numeric(4,3) check (confidence between 0 and 1),
  relevance numeric(4,3) not null default 0 check (relevance between 0 and 1),
  novelty numeric(4,3) not null default 0 check (novelty between 0 and 1),
  materiality numeric(4,3) not null default 0 check (materiality between 0 and 1),
  status text not null default 'current' check (status in ('current','contested','superseded','retracted','stale')),
  observed_at timestamptz not null default now(),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  refresh_after timestamptz,
  superseded_by uuid references public.intelligence_items(id),
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope='workspace' and workspace_id is not null) or (scope<>'workspace' and workspace_id is null)),
  unique(scope, workspace_id, domain, semantic_key)
);

create table if not exists public.intelligence_item_claims (
  intelligence_item_id uuid not null references public.intelligence_items(id) on delete cascade,
  claim_id uuid not null references public.research_claims(id) on delete cascade,
  role text not null check (role in ('supports','contradicts','context')),
  created_at timestamptz not null default now(),
  primary key(intelligence_item_id,claim_id,role)
);

create table if not exists public.intelligence_relations (
  id uuid primary key default gen_random_uuid(),
  from_item_id uuid not null references public.intelligence_items(id) on delete cascade,
  to_item_id uuid not null references public.intelligence_items(id) on delete cascade,
  relation_type text not null check (relation_type in ('related','corroborates','contradicts','supersedes','causes','implicates')),
  status text not null default 'active' check (status in ('active','resolved')),
  confidence numeric(4,3) check (confidence between 0 and 1),
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (from_item_id <> to_item_id),
  unique(from_item_id,to_item_id,relation_type)
);

create index if not exists intelligence_items_domain_rank_idx on public.intelligence_items(domain,status,materiality desc,relevance desc,observed_at desc);
create index if not exists intelligence_items_refresh_idx on public.intelligence_items(refresh_after) where status in ('current','contested');
create index if not exists intelligence_items_workspace_idx on public.intelligence_items(workspace_id,domain) where scope='workspace';
create index if not exists intelligence_relations_unresolved_idx on public.intelligence_relations(relation_type,status) where status='active';

alter table public.intelligence_items enable row level security;
alter table public.intelligence_item_claims enable row level security;
alter table public.intelligence_relations enable row level security;
revoke all on public.intelligence_items, public.intelligence_item_claims, public.intelligence_relations from anon, authenticated;

-- Epistemic guard: model conclusions without evidence may be stored only as inference/prediction/recommendation/unknown.
create or replace function public.enforce_intelligence_epistemic_evidence()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.epistemic_type in ('observed_source_fact','source_claim','corroborated_claim') and
     not exists (select 1 from public.intelligence_item_claims where intelligence_item_id=new.id and role='supports') then
    raise exception 'evidence-backed epistemic type requires supporting claim evidence';
  end if;
  return new;
end $$;

-- Deferred so ingestion can create the item and evidence edges atomically.
drop trigger if exists intelligence_items_epistemic_guard on public.intelligence_items;
create constraint trigger intelligence_items_epistemic_guard
after insert or update of epistemic_type on public.intelligence_items
deferrable initially deferred for each row execute function public.enforce_intelligence_epistemic_evidence();

revoke all on function public.enforce_intelligence_epistemic_evidence() from public, anon, authenticated;
grant execute on function public.enforce_intelligence_epistemic_evidence() to service_role;
