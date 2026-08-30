-- CHAT 8: Engineering Copilot closed-loop state for software coding sessions.
-- Extends the existing coding-session execution substrate. Physical/property
-- engineering remains in engineering_project_* and is intentionally not duplicated.

alter table public.caye_coding_sessions
  add column if not exists repository_full_name text not null default 'kwmlamar/caye',
  add column if not exists base_branch text not null default 'main',
  add column if not exists work_branch text,
  add column if not exists prediction text not null default 'Branch checks must pass; production remains unverified until separately observed.',
  add column if not exists rollback_plan text not null default 'Delete isolated review branch; main remains unchanged until separately authorized merge.',
  add column if not exists execution_evidence jsonb not null default '{}'::jsonb,
  add column if not exists observed_outcome text,
  add column if not exists prediction_comparison text,
  add column if not exists engineering_verdict text,
  add column if not exists outcome_environment text,
  add column if not exists production_verified boolean not null default false,
  add column if not exists merge_authorized boolean not null default false,
  add column if not exists deploy_authorized boolean not null default false,
  add column if not exists objective_run_id uuid references public.operator_objective_runs(id) on delete set null,
  add column if not exists workspace_id uuid references public.customers(id) on delete set null;

do $$ begin
  alter table public.caye_coding_sessions add constraint caye_coding_sessions_repo_identity_check
    check (repository_full_name = 'kwmlamar/caye');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.caye_coding_sessions add constraint caye_coding_sessions_base_branch_check
    check (base_branch = 'main');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.caye_coding_sessions add constraint caye_coding_sessions_work_branch_check
    check (work_branch is null or (work_branch <> base_branch and work_branch <> 'main' and work_branch like 'caye/coding-session/%'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.caye_coding_sessions add constraint caye_coding_sessions_prediction_comparison_check
    check (prediction_comparison is null or prediction_comparison in ('confirmed','contradicted','inconclusive'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.caye_coding_sessions add constraint caye_coding_sessions_engineering_verdict_check
    check (engineering_verdict is null or engineering_verdict in ('branch_verified','production_verified','failed','inconclusive'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.caye_coding_sessions add constraint caye_coding_sessions_outcome_environment_check
    check (outcome_environment is null or outcome_environment in ('branch','production'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.caye_coding_sessions add constraint caye_coding_sessions_production_truth_check
    check (
      not production_verified
      or (engineering_verdict = 'production_verified' and outcome_environment = 'production' and merge_authorized and deploy_authorized)
    );
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.caye_coding_sessions add constraint caye_coding_sessions_branch_verdict_truth_check
    check (
      engineering_verdict <> 'branch_verified'
      or (gate_test_passed is true and gate_build_passed is true and work_branch is not null and final_commit_sha is not null and production_verified is false)
    );
exception when duplicate_object then null; end $$;

create index if not exists caye_coding_sessions_objective_idx on public.caye_coding_sessions(objective_run_id) where objective_run_id is not null;
create index if not exists caye_coding_sessions_workspace_idx on public.caye_coding_sessions(workspace_id, created_at desc) where workspace_id is not null;

-- Keep objective linkage scope-honest: a workspace coding session may only link
-- to an objective run in the same workspace; founder sessions link only founder runs.
create or replace function public.caye_assert_coding_session_objective_scope()
returns trigger language plpgsql set search_path = public as $$
declare r_scope text; r_workspace uuid;
begin
  if new.objective_run_id is null then return new; end if;
  select scope_kind, workspace_id into r_scope, r_workspace from public.operator_objective_runs where id = new.objective_run_id;
  if r_scope is null then raise exception 'coding session objective run does not exist'; end if;
  if new.workspace_id is null and r_scope <> 'founder' then raise exception 'founder coding session must link to founder objective run'; end if;
  if new.workspace_id is not null and (r_scope <> 'workspace' or r_workspace is distinct from new.workspace_id) then
    raise exception 'coding session objective run is outside workspace scope';
  end if;
  return new;
end $$;
revoke all on function public.caye_assert_coding_session_objective_scope() from public, anon, authenticated;
drop trigger if exists caye_coding_session_objective_scope_guard on public.caye_coding_sessions;
create trigger caye_coding_session_objective_scope_guard before insert or update of objective_run_id, workspace_id
  on public.caye_coding_sessions for each row execute function public.caye_assert_coding_session_objective_scope();

revoke all on public.caye_coding_sessions from anon, authenticated;
