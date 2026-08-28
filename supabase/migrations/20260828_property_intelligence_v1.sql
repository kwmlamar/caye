-- CAY-25 Property Intelligence v0.1
-- Durable, workspace-scoped representation of physical properties and their
-- systems. This is descriptive state, not authorization to actuate devices or
-- proof that an engineering intervention is safe.

create table if not exists public.physical_properties (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  property_type text not null default 'residential' check (property_type in ('residential','commercial','mixed','land','other')),
  location_label text,
  status text not null default 'active' check (status in ('active','inactive','archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);
create index if not exists physical_properties_workspace_idx on public.physical_properties(workspace_id, status, created_at desc);

create table if not exists public.property_structures (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  property_id uuid not null references public.physical_properties(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  structure_type text not null default 'building' check (structure_type in ('building','shed','tank_pad','utility','other')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, name)
);
create index if not exists property_structures_property_idx on public.property_structures(workspace_id, property_id);

create table if not exists public.property_systems (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  property_id uuid not null references public.physical_properties(id) on delete cascade,
  structure_id uuid references public.property_structures(id) on delete set null,
  name text not null check (char_length(name) between 1 and 160),
  system_type text not null check (system_type in ('water','thermal','hvac','energy','electrical','network','security','wastewater','structural','other')),
  status text not null default 'active' check (status in ('active','inactive','unknown','needs_attention')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, name)
);
create index if not exists property_systems_property_idx on public.property_systems(workspace_id, property_id, system_type);

create table if not exists public.property_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  property_id uuid not null references public.physical_properties(id) on delete cascade,
  structure_id uuid references public.property_structures(id) on delete set null,
  system_id uuid references public.property_systems(id) on delete set null,
  name text not null check (char_length(name) between 1 and 160),
  asset_type text not null check (char_length(asset_type) between 1 and 80),
  manufacturer text,
  model text,
  status text not null default 'unknown' check (status in ('operational','offline','unknown','needs_attention','retired')),
  specifications jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, name)
);
create index if not exists property_assets_property_idx on public.property_assets(workspace_id, property_id, system_id, asset_type);

create table if not exists public.property_observations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  property_id uuid not null references public.physical_properties(id) on delete cascade,
  structure_id uuid references public.property_structures(id) on delete set null,
  system_id uuid references public.property_systems(id) on delete set null,
  asset_id uuid references public.property_assets(id) on delete set null,
  observation_key text not null check (char_length(observation_key) between 1 and 120),
  numeric_value double precision,
  text_value text,
  unit text,
  provenance_status text not null check (provenance_status in ('measured','observed','operator_confirmed','inferred','estimated')),
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source_artifact_id uuid references public.business_artifacts(id) on delete set null,
  source_message_id uuid references public.caye_operator_messages(id) on delete set null,
  notes text,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check ((numeric_value is not null)::integer + (text_value is not null)::integer = 1),
  check (numeric_value is null or (unit is not null and char_length(unit) between 1 and 40))
);
create index if not exists property_observations_lookup_idx on public.property_observations(workspace_id, property_id, observation_key, observed_at desc);
create index if not exists property_observations_asset_idx on public.property_observations(asset_id, observed_at desc) where asset_id is not null;

-- An uploaded photo/PDF stays in business_artifacts; this table only links
-- evidence to the physical world model. No second binary store is introduced.
create table if not exists public.property_artifact_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  property_id uuid not null references public.physical_properties(id) on delete cascade,
  structure_id uuid references public.property_structures(id) on delete set null,
  system_id uuid references public.property_systems(id) on delete set null,
  asset_id uuid references public.property_assets(id) on delete set null,
  artifact_id uuid not null references public.business_artifacts(id) on delete cascade,
  relation_type text not null default 'evidence' check (relation_type in ('evidence','photo_of','drawing_of','manual_for','measurement_source','other')),
  created_at timestamptz not null default now(),
  unique (property_id, artifact_id, relation_type)
);

alter table public.physical_properties enable row level security;
alter table public.property_structures enable row level security;
alter table public.property_systems enable row level security;
alter table public.property_assets enable row level security;
alter table public.property_observations enable row level security;
alter table public.property_artifact_links enable row level security;

-- All v0.1 access is through reviewed server-side service-role paths. Like the
-- existing engineering/artifact tables, there are intentionally no anon or
-- authenticated policies here.
