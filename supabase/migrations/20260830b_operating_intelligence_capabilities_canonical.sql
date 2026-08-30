-- Canonical Operating Intelligence capability roadmap for founder Direction.
--
-- IMPORTANT: 20260830_operating_intelligence_capabilities.sql was applied to
-- production before review and represented capabilities as caye_goals(kind='goal').
-- That collapses two different concepts: goals are durable intent (WHY), while
-- capabilities are cross-domain operating abilities (WHAT Caye can demonstrably do).
-- This remediation preserves the existing goal hierarchy, removes the seeded
-- capability-goal pollution, and introduces a first-class capability substrate.

create table if not exists public.caye_operating_intelligence_capabilities (
  id uuid primary key default gen_random_uuid(),
  capability_key text not null unique,
  title text not null unique,
  description text not null,
  maturity_status text not null default 'unverified'
    check (maturity_status in ('unverified', 'foundation', 'limited', 'active', 'future')),
  limitations jsonb not null default '[]'::jsonb,
  progress_percent numeric,
  progress_evidence_id bigint,
  last_verified_at timestamptz,
  sort_order integer not null unique check (sort_order between 1 and 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint caye_oi_capabilities_progress_range
    check (progress_percent is null or (progress_percent >= 0 and progress_percent <= 100)),
  constraint caye_oi_capabilities_progress_pair
    check ((progress_percent is null and progress_evidence_id is null)
       or (progress_percent is not null and progress_evidence_id is not null))
);

comment on table public.caye_operating_intelligence_capabilities is
  'Cross-domain roadmap capabilities for founder Direction. Separate from caye_goals: goals encode durable intent; capabilities encode evidence-backed operating ability.';
comment on column public.caye_operating_intelligence_capabilities.progress_percent is
  'Optional only. A numeric progress value is invalid without progress_evidence_id pointing to verified capability evidence.';

create table if not exists public.caye_operating_intelligence_capability_evidence (
  id bigint generated always as identity primary key,
  capability_id uuid not null references public.caye_operating_intelligence_capabilities(id) on delete cascade,
  evidence_kind text not null
    check (evidence_kind in ('runtime', 'outcome', 'metric', 'test', 'deployment', 'audit', 'implementation', 'document')),
  source_ref text not null,
  summary text not null,
  verifies_capability boolean not null default false,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  observed_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (capability_id, evidence_kind, source_ref)
);

comment on column public.caye_operating_intelligence_capability_evidence.verifies_capability is
  'False for implementation-only evidence such as code existence. True only when the evidence demonstrates actual capability behavior or outcome.';

alter table public.caye_operating_intelligence_capabilities
  drop constraint if exists caye_oi_capabilities_progress_evidence_fk;
alter table public.caye_operating_intelligence_capabilities
  add constraint caye_oi_capabilities_progress_evidence_fk
  foreign key (progress_evidence_id)
  references public.caye_operating_intelligence_capability_evidence(id)
  on delete set null;

create or replace function public.enforce_caye_oi_capability_progress_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  evidence_capability_id uuid;
  evidence_verifies boolean;
begin
  if new.progress_percent is null then
    return new;
  end if;

  select capability_id, verifies_capability
    into evidence_capability_id, evidence_verifies
    from public.caye_operating_intelligence_capability_evidence
   where id = new.progress_evidence_id;

  if not found
     or evidence_capability_id is distinct from new.id
     or evidence_verifies is not true then
    raise exception 'capability progress requires verified evidence for the same capability';
  end if;

  if new.last_verified_at is null then
    raise exception 'capability progress requires last_verified_at';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_caye_oi_capability_progress_evidence() from public;

drop trigger if exists caye_oi_capabilities_progress_guard on public.caye_operating_intelligence_capabilities;
create trigger caye_oi_capabilities_progress_guard
before insert or update of progress_percent, progress_evidence_id, last_verified_at
on public.caye_operating_intelligence_capabilities
for each row execute function public.enforce_caye_oi_capability_progress_evidence();

create table if not exists public.caye_operating_intelligence_capability_dependencies (
  capability_id uuid not null references public.caye_operating_intelligence_capabilities(id) on delete cascade,
  depends_on_capability_id uuid not null references public.caye_operating_intelligence_capabilities(id) on delete cascade,
  note text,
  created_at timestamptz not null default now(),
  primary key (capability_id, depends_on_capability_id),
  check (capability_id <> depends_on_capability_id)
);

create table if not exists public.caye_operating_intelligence_capability_goal_links (
  capability_id uuid not null references public.caye_operating_intelligence_capabilities(id) on delete cascade,
  goal_id uuid not null references public.caye_goals(id) on delete cascade,
  relationship text not null
    check (relationship in ('supports_objective', 'advanced_by_initiative', 'related')),
  created_at timestamptz not null default now(),
  primary key (capability_id, goal_id, relationship)
);

alter table public.caye_operating_intelligence_capabilities enable row level security;
alter table public.caye_operating_intelligence_capability_evidence enable row level security;
alter table public.caye_operating_intelligence_capability_dependencies enable row level security;
alter table public.caye_operating_intelligence_capability_goal_links enable row level security;

create index if not exists caye_oi_capability_evidence_capability_idx
  on public.caye_operating_intelligence_capability_evidence(capability_id, observed_at desc);
create index if not exists caye_oi_capability_goal_links_capability_idx
  on public.caye_operating_intelligence_capability_goal_links(capability_id);
create index if not exists caye_oi_capability_goal_links_goal_idx
  on public.caye_operating_intelligence_capability_goal_links(goal_id);

insert into public.caye_operating_intelligence_capabilities
  (capability_key, title, description, maturity_status, limitations, sort_order)
values
  ('perception_awareness', 'Perception & Continuous Awareness', 'Observe authorized systems and operational state, normalize observations, correlate signals, and detect meaningful change without waiting for a prompt.', 'unverified', '[]'::jsonb, 1),
  ('memory_context', 'Memory & Context', 'Maintain and retrieve durable, scoped context about people, organizations, properties, systems, projects, decisions, procedures, corrections, assumptions, outcomes and prior work.', 'unverified', '[]'::jsonb, 2),
  ('research_intelligence', 'Research & Intelligence', 'Search, investigate, verify, synthesize and maintain evidence-backed knowledge with explicit uncertainty, provenance and freshness.', 'unverified', '[]'::jsonb, 3),
  ('reasoning_simulation', 'Reasoning & Simulation', 'Reason over current state, compare alternatives, model consequences and use simulation where appropriate before decisions or action.', 'unverified', '[]'::jsonb, 4),
  ('planning_anticipation', 'Planning & Anticipation', 'Turn objectives into bounded plans, anticipate likely needs and changes, and revise plans from verified reality.', 'unverified', '[]'::jsonb, 5),
  ('execution_autonomy', 'Execution & Autonomy', 'Execute authorized work through real tools with idempotency, bounded retries, recovery, verification and complete auditability.', 'unverified', '[]'::jsonb, 6),
  ('monitoring_control', 'Monitoring & Control', 'Track running work, system state, quality, budgets, failures and side effects, intervening or escalating when control limits are crossed.', 'unverified', '[]'::jsonb, 7),
  ('engineering_copilot', 'Engineering Copilot', 'Assist with technical design, implementation, analysis, testing, debugging and engineering workflows while preserving evidence and review boundaries.', 'unverified', '[]'::jsonb, 8),
  ('environment_machine_interface', 'Environment & Machine Interface', 'Perceive and eventually interact with authorized devices, sensors, software environments, properties, robotics and other machine interfaces.', 'future', '[]'::jsonb, 9),
  ('adaptive_learning', 'Adaptive Learning', 'Learn from explicit corrections and measured outcomes with provenance, reversibility and contradiction handling, without silently expanding authority or rewriting policy.', 'unverified', '[]'::jsonb, 10),
  ('proactive_operator', 'Proactive Operator', 'Identify and perform useful authorized work without waiting for direct instruction, subject to goals, interruption budgets, risk and escalation policy.', 'unverified', '[]'::jsonb, 11),
  ('human_command_interface', 'Human Command Interface', 'Provide a coherent command surface across text, voice and other authorized channels so humans can inspect, direct, approve, correct and interrupt Caye.', 'unverified', '[]'::jsonb, 12)
on conflict (capability_key) do update set
  title = excluded.title,
  description = excluded.description,
  sort_order = excluded.sort_order,
  updated_at = now();

-- Every capability supports the durable autonomy objective. These are roadmap
-- relationships, not evidence that the capability exists.
insert into public.caye_operating_intelligence_capability_goal_links(capability_id, goal_id, relationship)
select c.id, g.id, 'supports_objective'
from public.caye_operating_intelligence_capabilities c
join public.caye_goals g
  on g.scope = 'operator'
 and g.title = 'Increase Caye''s operational autonomy.'
 and g.superseded_at is null
on conflict do nothing;

-- Preserve the existing engineering simulation initiative as a real initiative
-- and relate it to the capabilities it advances. The link itself is roadmap
-- structure, not proof of maturity.
insert into public.caye_operating_intelligence_capability_goal_links(capability_id, goal_id, relationship)
select c.id, g.id, 'advanced_by_initiative'
from public.caye_operating_intelligence_capabilities c
join public.caye_goals g
  on g.scope = 'operator'
 and g.kind = 'initiative'
 and g.title = 'Build Caye’s engineering simulation runtime.'
 and g.superseded_at is null
where c.capability_key in ('reasoning_simulation', 'engineering_copilot')
on conflict do nothing;

-- Domain/objective relationships make the cross-domain nature explicit without
-- nesting capabilities underneath those goals.
insert into public.caye_operating_intelligence_capability_goal_links(capability_id, goal_id, relationship)
select c.id, g.id, 'related'
from public.caye_operating_intelligence_capabilities c
join public.caye_goals g
  on g.scope = 'operator' and g.superseded_at is null
where (c.capability_key in ('memory_context', 'research_intelligence', 'reasoning_simulation', 'planning_anticipation', 'adaptive_learning') and g.title = 'Artificial intelligence.')
   or (c.capability_key in ('perception_awareness', 'monitoring_control', 'environment_machine_interface') and g.title = 'Robotics.')
   or (c.capability_key in ('research_intelligence', 'reasoning_simulation', 'monitoring_control') and g.title = 'Energy.')
on conflict do nothing;

-- Remove the prematurely seeded capability-as-goal model. Child rows in the
-- old capability tables are disposable because they contained implementation
-- references and unverified numeric maturity, not runtime/outcome evidence.
drop table if exists public.caye_goal_capability_initiatives;
drop table if exists public.caye_goal_capability_assessments;
drop table if exists public.caye_goal_capability_evidence;
drop table if exists public.caye_goal_capabilities;

delete from public.caye_goals
where source = 'seed:operating-intelligence-capabilities';
