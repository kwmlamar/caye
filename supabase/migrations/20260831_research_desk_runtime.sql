-- Generic standing-mission runtime state for Caye Research Desks.
-- Evidence remains canonical in research_runs/research_sources/research_claims/research_briefs.

create table if not exists public.research_desks (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.research_programs(id) on delete cascade,
  workspace_id uuid null,
  desk_key text not null,
  domain text not null,
  standing_mission text not null,
  standing_questions jsonb not null default '[]'::jsonb,
  cadence jsonb not null default '{"intervalMinutes": 360}'::jsonb,
  exploration_budget jsonb not null default '{"maxDepth": 2, "maxQueries": 8, "maxSources": 24, "timeoutMs": 120000}'::jsonb,
  source_preferences jsonb not null default '[]'::jsonb,
  geographic_scope jsonb not null default '[]'::jsonb,
  language_scope jsonb not null default '["English"]'::jsonb,
  current_hypotheses jsonb not null default '[]'::jsonb,
  last_successful_research timestamptz null,
  next_scheduled_investigation timestamptz null,
  confidence_threshold numeric not null default 0.65 check (confidence_threshold between 0 and 1),
  relevance_threshold numeric not null default 0.6 check (relevance_threshold between 0 and 1),
  escalation_policy jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','inactive')),
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (program_id, desk_key)
);

create index if not exists research_desks_due_idx
  on public.research_desks (next_scheduled_investigation)
  where status = 'active';
create index if not exists research_desks_workspace_idx on public.research_desks (workspace_id);

create table if not exists public.research_desk_cycles (
  id uuid primary key default gen_random_uuid(),
  desk_id uuid not null references public.research_desks(id) on delete cascade,
  wakeup_key text not null,
  status text not null default 'running' check (status in ('running','completed','partial','failed','budget_exhausted','unchanged')),
  material_change boolean not null default false,
  contradictory_evidence boolean not null default false,
  summary text null,
  fingerprint text null,
  budget_usage jsonb not null default '{}'::jsonb,
  checkpoint jsonb not null default '{}'::jsonb,
  next_scheduled_investigation timestamptz null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  unique (desk_id, wakeup_key)
);

create index if not exists research_desk_cycles_desk_started_idx
  on public.research_desk_cycles (desk_id, started_at desc);

-- These are internal operator tables. The service role owns orchestration; no
-- browser/client policy is intentionally exposed.
alter table public.research_desks enable row level security;
alter table public.research_desk_cycles enable row level security;

-- Claiming a due desk only reserves the wakeup. Search/fetch/synthesis still flow
-- through the canonical research runtime and its research_runs idempotency.
create or replace function public.claim_due_research_desk(p_worker text, p_now timestamptz default now())
returns table(desk_id uuid, wakeup_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desk public.research_desks%rowtype;
  v_wakeup text;
begin
  select * into v_desk
  from public.research_desks
  where status = 'active'
    and (next_scheduled_investigation is null or next_scheduled_investigation <= p_now)
  order by next_scheduled_investigation nulls first, created_at
  for update skip locked
  limit 1;

  if v_desk.id is null then return; end if;

  v_wakeup := 'schedule:' || to_char(date_trunc('minute', coalesce(v_desk.next_scheduled_investigation, p_now)), 'YYYYMMDDHH24MI');
  insert into public.research_desk_cycles (desk_id, wakeup_key, status, checkpoint)
  values (v_desk.id, v_wakeup, 'running', jsonb_build_object('claimedBy', p_worker))
  on conflict (desk_id, wakeup_key) do nothing;

  if not found then return; end if;

  -- Prevent another scheduler poll from immediately claiming the same desk while
  -- the cycle owns this wakeup. The runtime writes the actual next cadence later.
  update public.research_desks
  set next_scheduled_investigation = p_now + interval '15 minutes', updated_at = now()
  where id = v_desk.id;

  desk_id := v_desk.id;
  wakeup_key := v_wakeup;
  return next;
end;
$$;

revoke execute on function public.claim_due_research_desk(text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_due_research_desk(text, timestamptz) to service_role;

comment on table public.research_desks is 'Persistent standing missions and bounded exploration policy for generic Caye research desks.';
comment on table public.research_desk_cycles is 'Idempotent, replayable orchestration checkpoints; canonical evidence remains in research_* evidence tables.';
