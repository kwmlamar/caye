-- Durable objective execution state.
-- Supports both workspace-scoped operations and founder-only global workflows.

create table if not exists public.operator_objective_runs (
  id uuid primary key default gen_random_uuid(),
  objective_key text not null,
  scope_kind text not null check (scope_kind in ('workspace','founder')),
  workspace_id uuid references public.customers(id) on delete cascade,
  actor_key text not null,
  status text not null default 'running' check (status in ('running','completed','blocked','failed','budget_exhausted')),
  blocked_step text,
  max_transitions integer not null check (max_transitions between 1 and 100),
  timeout_ms integer not null check (timeout_ms between 1000 and 300000),
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    (scope_kind = 'workspace' and workspace_id is not null)
    or (scope_kind = 'founder' and workspace_id is null)
  )
);

create table if not exists public.operator_objective_events (
  id bigserial primary key,
  run_id uuid not null references public.operator_objective_runs(id) on delete cascade,
  step_key text not null,
  state text not null check (state in ('running','verified','blocked','failed')),
  attempt integer not null check (attempt >= 0),
  evidence jsonb,
  error text,
  occurred_at timestamptz not null default now()
);

create index if not exists operator_objective_runs_resume_idx
  on public.operator_objective_runs (objective_key, scope_kind, actor_key, status, updated_at desc);
create index if not exists operator_objective_events_run_idx
  on public.operator_objective_events (run_id, id);

-- Prevent two live runners for the exact same scoped objective.
create unique index if not exists operator_objective_runs_one_live_idx
  on public.operator_objective_runs (objective_key, scope_kind, actor_key, coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'running';

alter table public.operator_objective_runs enable row level security;
alter table public.operator_objective_events enable row level security;

-- Server/service-role only. No direct client policies.
