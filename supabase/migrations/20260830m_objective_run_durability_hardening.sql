-- Forward hardening for databases where the initial objective-run migration
-- was already applied before plan-version and durable-deadline semantics existed.

alter table public.operator_objective_runs
  add column if not exists plan_version text not null default '1',
  add column if not exists deadline_at timestamptz;

do $$ begin
  alter table public.operator_objective_runs add constraint operator_objective_runs_deadline_check
    check (deadline_at is null or deadline_at >= started_at);
exception when duplicate_object then null; end $$;

comment on column public.operator_objective_runs.plan_version is
  'Pins verified step keys to one objective-plan contract so deployments cannot silently reuse old verification semantics.';
comment on column public.operator_objective_runs.deadline_at is
  'Durable wall-clock deadline across execution slices; distinct from per-invocation timeout_ms.';
