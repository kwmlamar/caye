-- 2026-08-26 — Goal/objective substrate, part 1: schema only, no data.
--
-- WHY
-- Caye today reasons about "what needs attention right now" (owner-attention,
-- opportunity-scan) with no durable representation of WHY any of it matters
-- beyond the current turn. This adds the smallest structural chain that lets
-- Caye (and the founder) trace work back to an authorized objective:
--   VISION -> DOMAIN -> OBJECTIVE -> GOAL -> INITIATIVE
-- as one self-referential table (caye_goals, discriminated by `kind`) rather
-- than five separate tables.
--
-- WHAT THIS IS NOT
-- Not memory. business_facts/standing_rules answer "what does Caye know
-- about this business right now"; this answers "what is Caye trying to
-- accomplish and why" — status, priority, prerequisites, activation, and
-- supersession are semantics memory doesn't need and shouldn't grow.
--
-- Not the Work/Outcome runtime (CAY-8, Linear — "Design Caye's first-class
-- Work + Outcome runtime model"). This migration stops at `initiative`; it
-- does not model tasks, actions, evidence links to individual tool calls, or
-- an execution state machine. caye_goal_metrics is only a progress evidence
-- trail for strategic goals.
--
-- Not autonomy. Nothing here grants Caye permission to do anything; the
-- existing authority/confirmation architecture is untouched. A goal explains
-- why an action would be proposed; it never substitutes for the gate.
--
-- SCOPE / TENANCY
-- caye_goals.scope is 'workspace' (workspace_id set) or 'operator'
-- (workspace_id null — founder cross-business direction). RLS is enabled with
-- no authenticated/anon policies, matching the existing service-role-only
-- convention. Application reads remain explicitly scoped, AND the database
-- rejects parent/dependency graph edges that cross scope/workspace boundaries.
-- That second invariant matters because service-role reads bypass RLS: a bad
-- foreign-key edge must not become a side door from customer context into the
-- founder's operator/global strategy.
--
-- SUPERSESSION
-- The application preserves the old row and links it forward with
-- superseded_at/superseded_by. The founder route compensates by deleting a
-- newly-created replacement if retiring the old row fails, so an ordinary
-- partial DB failure fails closed instead of leaving two live goals. A future
-- RPC may make this pair crash-atomic if concurrent strategic writers become
-- a real requirement.

create table if not exists public.caye_goals (
  id                     uuid primary key default gen_random_uuid(),

  kind                   text not null check (kind in ('vision', 'domain', 'objective', 'goal', 'initiative')),
  parent_id              uuid references public.caye_goals (id) on delete set null,

  scope                  text not null check (scope in ('operator', 'workspace')),
  workspace_id           uuid references public.customers (id) on delete cascade,
  constraint caye_goals_scope_workspace_pairing check (
    (scope = 'workspace' and workspace_id is not null) or
    (scope = 'operator' and workspace_id is null)
  ),

  title                  text not null,
  description            text,

  status                 text not null default 'future'
                           check (status in ('active', 'future', 'blocked', 'paused', 'completed', 'abandoned')),
  priority               text not null default 'medium'
                           check (priority in ('low', 'medium', 'high', 'critical')),

  target_value           numeric,
  current_value          numeric,
  unit                   text,
  target_date            date,
  confidence             numeric(3, 2) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  completion_criteria    text,
  activation_conditions  jsonb,

  created_by_kind        text not null
                           check (created_by_kind in ('founder', 'owner', 'operator', 'system', 'caye_proposed')),
  created_by_label       text,
  created_by_user_id     uuid,
  created_by_operator_id bigint references public.operator_allowlist (id) on delete set null,
  source                 text,
  rationale              text,

  superseded_at          timestamptz,
  superseded_by          uuid references public.caye_goals (id) on delete set null,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.caye_goals is
  'Durable goal/objective substrate — VISION/DOMAIN/OBJECTIVE/GOAL/INITIATIVE as one self-referential table discriminated by kind. Not memory and not the Work/Outcome execution runtime. Goals explain why an action would be proposed; they never grant authority to perform one.';
comment on column public.caye_goals.scope is
  'operator = founder cross-workspace direction (workspace_id null). workspace = isolated to one customer.';
comment on column public.caye_goals.activation_conditions is
  'Advisory only. Read to compute surfaced eligibility; nothing auto-applies it.';

create index if not exists caye_goals_workspace_idx
  on public.caye_goals (workspace_id, status)
  where superseded_at is null;

create index if not exists caye_goals_operator_scope_idx
  on public.caye_goals (scope, status)
  where superseded_at is null and scope = 'operator';

create index if not exists caye_goals_parent_idx
  on public.caye_goals (parent_id)
  where superseded_at is null;

create index if not exists caye_goals_kind_idx
  on public.caye_goals (kind);

alter table public.caye_goals enable row level security;

-- Parent/child hierarchy is scope-local. Founder/operator strategy must never
-- become reachable from a customer workspace by following an id with the
-- service role, and one customer's hierarchy must never point at another.
create or replace function public.enforce_caye_goal_parent_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_scope text;
  parent_workspace_id uuid;
begin
  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception 'caye goal cannot be its own parent';
  end if;

  select scope, workspace_id
    into parent_scope, parent_workspace_id
    from public.caye_goals
   where id = new.parent_id;

  if not found then
    raise exception 'parent goal % does not exist', new.parent_id;
  end if;

  if parent_scope is distinct from new.scope
     or parent_workspace_id is distinct from new.workspace_id then
    raise exception 'caye goal parent must share scope and workspace';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_caye_goal_parent_scope() from public;

create trigger caye_goals_parent_scope_guard
before insert or update of parent_id, scope, workspace_id
on public.caye_goals
for each row
execute function public.enforce_caye_goal_parent_scope();

-- ── Dependencies / prerequisites ────────────────────────────────────────────

create table if not exists public.caye_goal_dependencies (
  id                 bigint generated always as identity primary key,
  goal_id            uuid not null references public.caye_goals (id) on delete cascade,
  depends_on_goal_id uuid not null references public.caye_goals (id) on delete cascade,
  created_at         timestamptz not null default now(),
  constraint caye_goal_dependencies_not_self check (goal_id <> depends_on_goal_id),
  constraint caye_goal_dependencies_unique unique (goal_id, depends_on_goal_id)
);

comment on table public.caye_goal_dependencies is
  'Prerequisite edges between goals, independent of the parent_id hierarchy. Dependencies are constrained to the same scope/workspace.';

create index if not exists caye_goal_dependencies_goal_idx
  on public.caye_goal_dependencies (goal_id);
create index if not exists caye_goal_dependencies_depends_on_idx
  on public.caye_goal_dependencies (depends_on_goal_id);

alter table public.caye_goal_dependencies enable row level security;

create or replace function public.enforce_caye_goal_dependency_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  goal_scope text;
  goal_workspace_id uuid;
  dependency_scope text;
  dependency_workspace_id uuid;
begin
  select scope, workspace_id
    into goal_scope, goal_workspace_id
    from public.caye_goals
   where id = new.goal_id;
  if not found then
    raise exception 'goal % does not exist', new.goal_id;
  end if;

  select scope, workspace_id
    into dependency_scope, dependency_workspace_id
    from public.caye_goals
   where id = new.depends_on_goal_id;
  if not found then
    raise exception 'dependency goal % does not exist', new.depends_on_goal_id;
  end if;

  if goal_scope is distinct from dependency_scope
     or goal_workspace_id is distinct from dependency_workspace_id then
    raise exception 'caye goal dependencies must share scope and workspace';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_caye_goal_dependency_scope() from public;

create trigger caye_goal_dependencies_scope_guard
before insert or update of goal_id, depends_on_goal_id
on public.caye_goal_dependencies
for each row
execute function public.enforce_caye_goal_dependency_scope();

-- ── Metrics / evidence ──────────────────────────────────────────────────────

create table if not exists public.caye_goal_metrics (
  id            bigint generated always as identity primary key,
  goal_id       uuid not null references public.caye_goals (id) on delete cascade,

  metric_key    text not null,
  value         numeric not null,
  unit          text,

  evidence_kind text not null default 'authoritative' check (evidence_kind in ('authoritative', 'estimated')),
  source        text not null,
  evidence_ref  text,
  recorded_by   text,
  note          text,

  observed_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

comment on table public.caye_goal_metrics is
  'Evidence used to determine real progress toward a goal. Prefer authoritative sources; estimated observations remain explicitly labeled.';

create index if not exists caye_goal_metrics_goal_idx
  on public.caye_goal_metrics (goal_id, observed_at desc);

alter table public.caye_goal_metrics enable row level security;
