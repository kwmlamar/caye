-- Research Runtime V1: evidence first, interpretation second, authority unchanged.
create extension if not exists pgcrypto;

create table if not exists public.research_programs (
  id uuid primary key default gen_random_uuid(), goal_id uuid not null references public.caye_goals(id) on delete cascade,
  workspace_id uuid null, scope text not null default 'operator' check (scope in ('operator','workspace')),
  title text not null, status text not null default 'active' check (status in ('active','paused','completed','archived')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(goal_id,title)
);
create table if not exists public.research_questions (
  id uuid primary key default gen_random_uuid(), program_id uuid not null references public.research_programs(id) on delete cascade,
  question text not null, status text not null default 'open' check (status in ('open','researching','answered','paused','archived')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(program_id,question)
);
create table if not exists public.research_runs (
  id uuid primary key default gen_random_uuid(), question_id uuid not null references public.research_questions(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','completed','partial','failed','cancelled')),
  trigger_source text not null default 'founder', provider text, claimed_at timestamptz, claimed_by text, started_at timestamptz, completed_at timestamptz,
  error text, cost_usd numeric(12,6), provenance jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create unique index if not exists research_runs_one_active_per_question_idx on public.research_runs(question_id) where status in ('queued','running');
create table if not exists public.research_sources (
  id uuid primary key default gen_random_uuid(), canonical_url text not null, source_type text not null default 'web', title text,
  publisher text, observed_at timestamptz not null default now(), fetched_at timestamptz, content_hash text, snapshot jsonb not null default '{}'::jsonb,
  quality text not null default 'unknown' check (quality in ('primary','peer_reviewed','original_repo','independent','community','unknown')),
  unique(canonical_url,content_hash)
);
create table if not exists public.research_run_sources (
  run_id uuid not null references public.research_runs(id) on delete cascade, source_id uuid not null references public.research_sources(id) on delete cascade,
  discovered_at timestamptz not null default now(), primary key(run_id,source_id)
);
create table if not exists public.research_claims (
  id uuid primary key default gen_random_uuid(), question_id uuid not null references public.research_questions(id) on delete cascade,
  run_id uuid not null references public.research_runs(id) on delete cascade, claim_type text not null default 'finding' check (claim_type in ('finding','hypothesis','implication','unknown')),
  statement text not null, confidence numeric(4,3) check (confidence between 0 and 1), source_quality text,
  status text not null default 'current' check (status in ('current','contested','superseded','retracted')),
  valid_from timestamptz not null default now(), valid_until timestamptz, superseded_by uuid references public.research_claims(id), provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.research_claim_evidence (
  claim_id uuid not null references public.research_claims(id) on delete cascade, source_id uuid not null references public.research_sources(id) on delete cascade,
  stance text not null check (stance in ('supports','contradicts','context')), excerpt text, created_at timestamptz not null default now(), primary key(claim_id,source_id,stance)
);
create table if not exists public.research_briefs (
  id uuid primary key default gen_random_uuid(), question_id uuid not null references public.research_questions(id) on delete cascade,
  run_id uuid not null references public.research_runs(id) on delete cascade, revision integer not null,
  current_understanding text not null, strongest_evidence jsonb not null default '[]'::jsonb, conflicting_evidence jsonb not null default '[]'::jsonb,
  unknowns jsonb not null default '[]'::jsonb, material_changes jsonb not null default '[]'::jsonb, implications jsonb not null default '[]'::jsonb,
  recommendations jsonb not null default '[]'::jsonb, provenance jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), unique(question_id,revision)
);

-- Service role only in V1. Founder access is mediated server-side through Caye capabilities.
alter table public.research_programs enable row level security;
alter table public.research_questions enable row level security;
alter table public.research_runs enable row level security;
alter table public.research_sources enable row level security;
alter table public.research_run_sources enable row level security;
alter table public.research_claims enable row level security;
alter table public.research_claim_evidence enable row level security;
alter table public.research_briefs enable row level security;
revoke all on public.research_programs, public.research_questions, public.research_runs, public.research_sources, public.research_run_sources, public.research_claims, public.research_claim_evidence, public.research_briefs from anon, authenticated;

create or replace function public.claim_research_run(p_worker text)
returns setof public.research_runs language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  select id into v_id from public.research_runs where status='queued' order by created_at for update skip locked limit 1;
  if v_id is null then return; end if;
  return query update public.research_runs set status='running', claimed_at=now(), claimed_by=p_worker, started_at=coalesce(started_at,now()) where id=v_id and status='queued' returning *;
end $$;
revoke all on function public.claim_research_run(text) from public, anon, authenticated;
grant execute on function public.claim_research_run(text) to service_role;

insert into public.research_programs(goal_id,scope,title,status)
values ('00df8e47-cb52-43a6-8fca-4f8e31da101f','operator','Caye AI Systems Research','active') on conflict(goal_id,title) do nothing;
with p as (select id from public.research_programs where goal_id='00df8e47-cb52-43a6-8fca-4f8e31da101f' and title='Caye AI Systems Research')
insert into public.research_questions(program_id,question) select p.id,q from p cross join (values
 ('Which agent architectures measurably improve Caye''s reliability and autonomy without weakening authority boundaries?'),
 ('Can Caye route routine work to smaller/local models while preserving task quality and reducing cost and latency?'),
 ('Which memory and continual-learning architectures are appropriate for Caye''s durable operating intelligence?'),
 ('Which computer-use/tool-use techniques improve Caye''s execution success on real operating tasks?')
) v(q) on conflict(program_id,question) do nothing;