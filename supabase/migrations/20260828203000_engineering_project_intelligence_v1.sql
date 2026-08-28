-- CAY-26 Project / Experiment Intelligence v0.1
-- Durable engineering change lifecycle linked to Property Intelligence.
-- This schema records intent/evidence. It grants no authority for physical actuation.

create table if not exists public.engineering_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  property_id uuid not null,
  structure_id uuid,
  system_id uuid,
  asset_id uuid,
  name text not null check (length(trim(name)) between 1 and 240),
  objective text not null check (length(trim(objective)) between 1 and 4000),
  problem_statement text,
  status text not null default 'planning' check (status in ('planning','selected','executing','measuring','completed','abandoned')),
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  success_criteria jsonb not null default '[]'::jsonb check (jsonb_typeof(success_criteria) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, property_id) references public.physical_properties(workspace_id, id) on delete cascade,
  foreign key (workspace_id, property_id, structure_id) references public.property_structures(workspace_id, property_id, id),
  foreign key (workspace_id, property_id, system_id) references public.property_systems(workspace_id, property_id, id),
  foreign key (workspace_id, property_id, asset_id) references public.property_assets(workspace_id, property_id, id)
);
create index if not exists engineering_projects_property_idx on public.engineering_projects(workspace_id, property_id, status, updated_at desc);

create table if not exists public.engineering_project_baselines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  revision integer not null default 1 check (revision > 0),
  status text not null default 'draft' check (status in ('draft','frozen')),
  notes text,
  frozen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, project_id, revision),
  unique (workspace_id, id),
  foreign key (workspace_id, project_id) references public.engineering_projects(workspace_id, id) on delete cascade,
  check ((status = 'frozen' and frozen_at is not null) or (status = 'draft' and frozen_at is null))
);

create table if not exists public.engineering_project_baseline_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  baseline_id uuid not null,
  property_observation_id uuid not null references public.property_observations(id),
  created_at timestamptz not null default now(),
  unique (baseline_id, property_observation_id),
  foreign key (workspace_id, baseline_id) references public.engineering_project_baselines(workspace_id, id) on delete cascade
);

create table if not exists public.engineering_project_alternatives (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  alternative_key text not null check (length(trim(alternative_key)) between 1 and 120),
  revision integer not null default 1 check (revision > 0),
  title text not null check (length(trim(title)) between 1 and 240),
  description text not null check (length(trim(description)) between 1 and 8000),
  assumptions jsonb not null default '[]'::jsonb check (jsonb_typeof(assumptions) = 'array'),
  dependencies jsonb not null default '[]'::jsonb check (jsonb_typeof(dependencies) = 'array'),
  status text not null default 'candidate' check (status in ('candidate','selected','rejected','superseded')),
  estimated_cost numeric,
  cost_currency text,
  created_at timestamptz not null default now(),
  unique (workspace_id, project_id, alternative_key, revision),
  unique (workspace_id, id),
  foreign key (workspace_id, project_id) references public.engineering_projects(workspace_id, id) on delete cascade,
  check ((estimated_cost is null and cost_currency is null) or (estimated_cost >= 0 and length(trim(cost_currency)) between 3 and 16))
);

create table if not exists public.engineering_project_predictions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  alternative_id uuid not null,
  metric_key text not null check (length(trim(metric_key)) between 1 and 160),
  numeric_value numeric not null,
  unit text not null check (length(trim(unit)) between 1 and 64),
  provenance_status text not null check (provenance_status in ('operator_confirmed','inferred','estimated')),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  rationale text,
  analysis_ref text,
  artifact_ref text,
  created_at timestamptz not null default now(),
  unique (alternative_id, metric_key),
  foreign key (workspace_id, project_id) references public.engineering_projects(workspace_id, id) on delete cascade,
  foreign key (workspace_id, alternative_id) references public.engineering_project_alternatives(workspace_id, id) on delete cascade
);

create table if not exists public.engineering_project_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  alternative_id uuid not null,
  source_message_id uuid not null references public.caye_operator_messages(id),
  rationale text,
  selected_at timestamptz not null default now(),
  superseded_at timestamptz,
  foreign key (workspace_id, project_id) references public.engineering_projects(workspace_id, id) on delete cascade,
  foreign key (workspace_id, alternative_id) references public.engineering_project_alternatives(workspace_id, id)
);
create unique index if not exists engineering_project_one_active_decision_idx on public.engineering_project_decisions(project_id) where superseded_at is null;

create table if not exists public.engineering_project_execution_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  alternative_id uuid,
  evidence_type text not null check (evidence_type in ('operator_confirmation','artifact','installed_asset')),
  source_message_id uuid not null references public.caye_operator_messages(id),
  source_artifact_id uuid references public.business_artifacts(id),
  installed_asset_id uuid references public.property_assets(id),
  notes text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, project_id) references public.engineering_projects(workspace_id, id) on delete cascade,
  foreign key (workspace_id, alternative_id) references public.engineering_project_alternatives(workspace_id, id),
  check (source_artifact_id is not null or installed_asset_id is not null or length(trim(coalesce(notes,''))) > 0)
);

create table if not exists public.engineering_project_outcomes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  metric_key text not null check (length(trim(metric_key)) between 1 and 160),
  property_observation_id uuid not null references public.property_observations(id),
  created_at timestamptz not null default now(),
  unique (project_id, metric_key, property_observation_id),
  foreign key (workspace_id, project_id) references public.engineering_projects(workspace_id, id) on delete cascade
);

create table if not exists public.engineering_project_verdicts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  verdict text not null check (verdict in ('succeeded','partially_succeeded','failed','inconclusive')),
  reason_codes jsonb not null default '[]'::jsonb check (jsonb_typeof(reason_codes) = 'array'),
  summary text not null check (length(trim(summary)) between 1 and 8000),
  source_message_id uuid not null references public.caye_operator_messages(id),
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  foreign key (workspace_id, project_id) references public.engineering_projects(workspace_id, id) on delete cascade
);
create unique index if not exists engineering_project_one_active_verdict_idx on public.engineering_project_verdicts(project_id) where superseded_at is null;

create or replace function public.caye_assert_engineering_project_relation_scope()
returns trigger language plpgsql set search_path = public as $$
declare project_property_id uuid;
begin
  select property_id into project_property_id from public.engineering_projects p where p.id = new.project_id and p.workspace_id = new.workspace_id;
  if project_property_id is null then raise exception 'engineering project is not in this workspace'; end if;
  if tg_table_name = 'engineering_project_predictions' and not exists (select 1 from public.engineering_project_alternatives a where a.id = new.alternative_id and a.project_id = new.project_id and a.workspace_id = new.workspace_id) then raise exception 'prediction alternative is not part of this project'; end if;
  if tg_table_name = 'engineering_project_decisions' then
    if not exists (select 1 from public.engineering_project_alternatives a where a.id = new.alternative_id and a.project_id = new.project_id and a.workspace_id = new.workspace_id) then raise exception 'decision alternative is not part of this project'; end if;
    if not exists (select 1 from public.caye_operator_messages m where m.id = new.source_message_id and m.workspace_id = new.workspace_id and m.direction = 'inbound' and m.origin = 'dashboard') then raise exception 'engineering decision source must be an inbound founder dashboard message in this workspace'; end if;
  end if;
  if tg_table_name = 'engineering_project_execution_evidence' then
    if new.alternative_id is not null and not exists (select 1 from public.engineering_project_alternatives a where a.id = new.alternative_id and a.project_id = new.project_id and a.workspace_id = new.workspace_id) then raise exception 'execution alternative is not part of this project'; end if;
    if not exists (select 1 from public.caye_operator_messages m where m.id = new.source_message_id and m.workspace_id = new.workspace_id and m.direction = 'inbound' and m.origin = 'dashboard') then raise exception 'execution source must be an inbound founder dashboard message in this workspace'; end if;
    if new.source_artifact_id is not null and not exists (select 1 from public.business_artifacts a where a.id = new.source_artifact_id and a.workspace_id = new.workspace_id) then raise exception 'execution artifact is not in this workspace'; end if;
    if new.installed_asset_id is not null and not exists (select 1 from public.property_assets a where a.id = new.installed_asset_id and a.workspace_id = new.workspace_id and a.property_id = project_property_id) then raise exception 'installed asset is not part of this project property'; end if;
  end if;
  if tg_table_name = 'engineering_project_outcomes' and not exists (select 1 from public.property_observations o where o.id = new.property_observation_id and o.workspace_id = new.workspace_id and o.property_id = project_property_id) then raise exception 'outcome observation is not part of this project property'; end if;
  if tg_table_name = 'engineering_project_verdicts' and not exists (select 1 from public.caye_operator_messages m where m.id = new.source_message_id and m.workspace_id = new.workspace_id and m.direction = 'inbound' and m.origin = 'dashboard') then raise exception 'verdict source must be an inbound founder dashboard message in this workspace'; end if;
  return new;
end $$;
revoke all on function public.caye_assert_engineering_project_relation_scope() from public, anon, authenticated;

create or replace function public.caye_assert_engineering_baseline_item_scope()
returns trigger language plpgsql set search_path = public as $$
declare baseline_status text; baseline_workspace uuid; project_property_id uuid;
begin
  select b.status, b.workspace_id, p.property_id into baseline_status, baseline_workspace, project_property_id from public.engineering_project_baselines b join public.engineering_projects p on p.id = b.project_id where b.id = coalesce(new.baseline_id, old.baseline_id);
  if baseline_workspace is null or baseline_workspace <> coalesce(new.workspace_id, old.workspace_id) then raise exception 'baseline is not in this workspace'; end if;
  if baseline_status = 'frozen' then raise exception 'Frozen engineering baseline items are immutable'; end if;
  if tg_op <> 'DELETE' and not exists (select 1 from public.property_observations o where o.id = new.property_observation_id and o.workspace_id = new.workspace_id and o.property_id = project_property_id) then raise exception 'baseline observation is not part of this project property'; end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;
revoke all on function public.caye_assert_engineering_baseline_item_scope() from public, anon, authenticated;

create or replace function public.prevent_frozen_engineering_baseline_mutation()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.status = 'frozen' then raise exception 'Frozen engineering baseline is immutable'; end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;
revoke all on function public.prevent_frozen_engineering_baseline_mutation() from public, anon, authenticated;

drop trigger if exists engineering_baseline_immutable on public.engineering_project_baselines;
create trigger engineering_baseline_immutable before update or delete on public.engineering_project_baselines for each row execute function public.prevent_frozen_engineering_baseline_mutation();
drop trigger if exists engineering_baseline_items_scope_and_immutable on public.engineering_project_baseline_items;
create trigger engineering_baseline_items_scope_and_immutable before insert or update or delete on public.engineering_project_baseline_items for each row execute function public.caye_assert_engineering_baseline_item_scope();
drop trigger if exists engineering_prediction_scope_guard on public.engineering_project_predictions;
create trigger engineering_prediction_scope_guard before insert or update on public.engineering_project_predictions for each row execute function public.caye_assert_engineering_project_relation_scope();
drop trigger if exists engineering_decision_scope_guard on public.engineering_project_decisions;
create trigger engineering_decision_scope_guard before insert or update on public.engineering_project_decisions for each row execute function public.caye_assert_engineering_project_relation_scope();
drop trigger if exists engineering_execution_scope_guard on public.engineering_project_execution_evidence;
create trigger engineering_execution_scope_guard before insert or update on public.engineering_project_execution_evidence for each row execute function public.caye_assert_engineering_project_relation_scope();
drop trigger if exists engineering_outcome_scope_guard on public.engineering_project_outcomes;
create trigger engineering_outcome_scope_guard before insert or update on public.engineering_project_outcomes for each row execute function public.caye_assert_engineering_project_relation_scope();
drop trigger if exists engineering_verdict_scope_guard on public.engineering_project_verdicts;
create trigger engineering_verdict_scope_guard before insert or update on public.engineering_project_verdicts for each row execute function public.caye_assert_engineering_project_relation_scope();

alter table public.engineering_projects enable row level security;
alter table public.engineering_project_baselines enable row level security;
alter table public.engineering_project_baseline_items enable row level security;
alter table public.engineering_project_alternatives enable row level security;
alter table public.engineering_project_predictions enable row level security;
alter table public.engineering_project_decisions enable row level security;
alter table public.engineering_project_execution_evidence enable row level security;
alter table public.engineering_project_outcomes enable row level security;
alter table public.engineering_project_verdicts enable row level security;
revoke all on public.engineering_projects from anon, authenticated;
revoke all on public.engineering_project_baselines from anon, authenticated;
revoke all on public.engineering_project_baseline_items from anon, authenticated;
revoke all on public.engineering_project_alternatives from anon, authenticated;
revoke all on public.engineering_project_predictions from anon, authenticated;
revoke all on public.engineering_project_decisions from anon, authenticated;
revoke all on public.engineering_project_execution_evidence from anon, authenticated;
revoke all on public.engineering_project_outcomes from anon, authenticated;
revoke all on public.engineering_project_verdicts from anon, authenticated;
