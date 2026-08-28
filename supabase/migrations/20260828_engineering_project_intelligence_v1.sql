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

create table if not exists public.engineering_project_baselines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  revision integer not null default 1 check (revision > 0),
  status text not null default 'frozen' check (status in ('draft','frozen')),
  notes text,
  frozen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, project_id, revision),
  unique (workspace_id, id),
  foreign key (workspace_id, project_id) references public.engineering_projects(workspace_id, id) on delete cascade,
  check ((status = 'frozen' and frozen_at is not null) or status = 'draft')
);

create table if not exists public.engineering_project_baseline_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  baseline_id uuid not null,
  property_observation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (baseline_id, property_observation_id),
  foreign key (workspace_id, baseline_id) references public.engineering_project_baselines(workspace_id, id) on delete cascade,
  foreign key (workspace_id, property_observation_id) references public.property_observations(workspace_id, id)
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
  source_message_id uuid not null,
  rationale text,
  selected_at timestamptz not null default now(),
  superseded_at timestamptz,
  foreign key (workspace_id, project_id) references public.engineering_projects(workspace_id, id) on delete cascade,
  foreign key (workspace_id, alternative_id) references public.engineering_project_alternatives(workspace_id, id),
  foreign key (workspace_id, source_message_id) references public.caye_operator_messages(workspace_id, id)
);
create unique index if not exists engineering_project_one_active_decision_idx
  on public.engineering_project_decisions(project_id) where superseded_at is null;

create table if not exists public.engineering_project_execution_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  alternative_id uuid,
  evidence_type text not null check (evidence_type in ('operator_confirmation','artifact','installed_asset')),
  source_message_id uuid not null,
  source_artifact_id uuid,
  installed_asset_id uuid,
  notes text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, project_id) references public.engineering_projects(workspace_id, id) on delete cascade,
  foreign key (workspace_id, alternative_id) references public.engineering_project_alternatives(workspace_id, id),
  foreign key (workspace_id, source_message_id) references public.caye_operator_messages(workspace_id, id),
  foreign key (workspace_id, source_artifact_id) references public.business_artifacts(workspace_id, id),
  foreign key (workspace_id, installed_asset_id) references public.property_assets(workspace_id, id),
  check (source_artifact_id is not null or installed_asset_id is not null or length(trim(coalesce(notes,''))) > 0)
);

create table if not exists public.engineering_project_outcomes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  metric_key text not null check (length(trim(metric_key)) between 1 and 160),
  property_observation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (project_id, metric_key, property_observation_id),
  foreign key (workspace_id, project_id) references public.engineering_projects(workspace_id, id) on delete cascade,
  foreign key (workspace_id, property_observation_id) references public.property_observations(workspace_id, id)
);

create table if not exists public.engineering_project_verdicts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  verdict text not null check (verdict in ('succeeded','partially_succeeded','failed','inconclusive')),
  reason_codes jsonb not null default '[]'::jsonb check (jsonb_typeof(reason_codes) = 'array'),
  summary text not null check (length(trim(summary)) between 1 and 8000),
  source_message_id uuid not null,
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  foreign key (workspace_id, project_id) references public.engineering_projects(workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_message_id) references public.caye_operator_messages(workspace_id, id)
);
create unique index if not exists engineering_project_one_active_verdict_idx
  on public.engineering_project_verdicts(project_id) where superseded_at is null;

create or replace function public.prevent_frozen_engineering_baseline_mutation()
returns trigger language plpgsql set search_path = public as $$
declare baseline_status text;
begin
  if tg_table_name = 'engineering_project_baselines' then
    if old.status = 'frozen' then raise exception 'Frozen engineering baseline is immutable'; end if;
  else
    select status into baseline_status from public.engineering_project_baselines where id = coalesce(old.baseline_id, new.baseline_id);
    if baseline_status = 'frozen' then raise exception 'Frozen engineering baseline items are immutable'; end if;
  end if;
  return coalesce(new, old);
end $$;

revoke all on function public.prevent_frozen_engineering_baseline_mutation() from public, anon, authenticated;

drop trigger if exists engineering_baseline_immutable on public.engineering_project_baselines;
create trigger engineering_baseline_immutable before update or delete on public.engineering_project_baselines
for each row execute function public.prevent_frozen_engineering_baseline_mutation();

drop trigger if exists engineering_baseline_items_immutable on public.engineering_project_baseline_items;
create trigger engineering_baseline_items_immutable before insert or update or delete on public.engineering_project_baseline_items
for each row execute function public.prevent_frozen_engineering_baseline_mutation();

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
