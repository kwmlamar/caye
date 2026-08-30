-- Growth Intelligence v1
-- Workspace-scoped evidence store for OBSERVE -> UNDERSTAND -> DIAGNOSE -> RECOMMEND.
-- Critical invariant: unavailable/disconnected sources are represented explicitly,
-- never coerced to zero-valued metrics.

create table if not exists public.growth_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  provider text not null check (provider in ('ga4','search_console','bookings','inquiries','manual')),
  status text not null default 'disconnected' check (status in ('connected','disconnected','error')),
  external_account_ref text,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider)
);

create table if not exists public.growth_observations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  source_id uuid references public.growth_sources(id) on delete set null,
  metric_key text not null,
  metric_value numeric,
  metric_unit text not null default 'count',
  observed_at timestamptz not null,
  period_start timestamptz,
  period_end timestamptz,
  dimension jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check ((metric_value is not null) or (provenance ? 'unavailable_reason'))
);

create index if not exists growth_observations_workspace_metric_time_idx
  on public.growth_observations (workspace_id, metric_key, observed_at desc);

create table if not exists public.growth_diagnoses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  diagnosis_key text not null,
  headline text not null,
  explanation text not null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  evidence_observation_ids uuid[] not null default '{}',
  missing_sources text[] not null default '{}',
  freshness text not null default 'fresh' check (freshness in ('fresh','stale','insufficient')),
  generated_at timestamptz not null default now(),
  superseded_at timestamptz
);

create table if not exists public.growth_recommendations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  diagnosis_id uuid not null references public.growth_diagnoses(id) on delete cascade,
  title text not null,
  rationale text not null,
  priority integer not null default 50 check (priority between 0 and 100),
  recommended_action jsonb not null default '{}'::jsonb,
  status text not null default 'proposed' check (status in ('proposed','dismissed','accepted')),
  created_at timestamptz not null default now()
);

alter table public.growth_sources enable row level security;
alter table public.growth_observations enable row level security;
alter table public.growth_diagnoses enable row level security;
alter table public.growth_recommendations enable row level security;

-- No client-side policies in v1. These tables are accessed through Caye's
-- server-side service role + capability boundary, preserving workspace scope.