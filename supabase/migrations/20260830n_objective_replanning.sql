-- Durable replanning and wait/resume semantics for long-lived operator objectives.
-- Runtime plan revisions are distinct from plan_version, which still pins the
-- deployed code contract for verified step compatibility.

alter table public.operator_objective_runs
  add column if not exists plan_revision integer not null default 0,
  add column if not exists max_plan_revisions integer not null default 2,
  add column if not exists resume_at timestamptz;

do $$ begin
  alter table public.operator_objective_runs add constraint operator_objective_runs_plan_revision_check
    check (plan_revision >= 0 and max_plan_revisions between 0 and 10 and plan_revision <= max_plan_revisions);
exception when duplicate_object then null; end $$;

alter table public.operator_objective_runs
  drop constraint if exists operator_objective_runs_status_check;
alter table public.operator_objective_runs
  add constraint operator_objective_runs_status_check
  check (status in ('running','waiting','completed','blocked','failed','budget_exhausted'));

alter table public.operator_objective_events
  drop constraint if exists operator_objective_events_state_check;
alter table public.operator_objective_events
  add constraint operator_objective_events_state_check
  check (state in ('checking','running','verified','blocked','failed','replanned','waiting'));

-- A waiting or slice-budget-exhausted run is still live only while incomplete.
-- Terminal budget-exhausted rows retain their evidence but must not prevent a
-- future fresh objective from starting.
drop index if exists public.operator_objective_runs_one_live_idx;
create unique index operator_objective_runs_one_live_idx
  on public.operator_objective_runs (
    objective_key,
    scope_kind,
    actor_key,
    coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where completed_at is null and status in ('running','waiting','budget_exhausted');

create index if not exists operator_objective_runs_resume_at_idx
  on public.operator_objective_runs (status, resume_at)
  where status = 'waiting' and completed_at is null;

comment on column public.operator_objective_runs.plan_revision is
  'Bounded runtime revision number when observed reality invalidates assumptions without changing the deployed plan contract.';
comment on column public.operator_objective_runs.max_plan_revisions is
  'Hard cap on runtime plan revisions so changed reality cannot create an unbounded replanning loop.';
comment on column public.operator_objective_runs.resume_at is
  'Advisory durable resume time for objectives waiting on state or indeterminate verification; leases are released while waiting.';
