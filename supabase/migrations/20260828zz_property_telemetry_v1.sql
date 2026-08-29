-- Property Telemetry v1
--
-- Stage-2 physical-world sensing boundary for Property Intelligence.
-- Raw provider events are retained verbatim, normalized measurements are provider-agnostic,
-- and derived physical state is kept separate so calibration can evolve without rewriting history.
--
-- Security model: service-role only. RLS is enabled and no client policies are created.

create table if not exists public.property_sensor_devices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  property_id uuid not null references public.physical_properties(id) on delete cascade,
  system_id uuid references public.property_systems(id) on delete set null,
  asset_id uuid references public.property_assets(id) on delete set null,
  device_key text not null,
  provider text not null,
  provider_application_id text,
  provider_device_id text not null,
  sensor_kind text not null,
  status text not null default 'planned' check (status in ('planned','provisioned','active','stale','offline','retired')),
  calibration jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  installed_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, device_key),
  unique (provider, provider_application_id, provider_device_id)
);

create index if not exists property_sensor_devices_property_idx
  on public.property_sensor_devices(property_id, status);
create index if not exists property_sensor_devices_asset_idx
  on public.property_sensor_devices(asset_id)
  where asset_id is not null;

create table if not exists public.property_telemetry_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  property_id uuid not null references public.physical_properties(id) on delete cascade,
  device_id uuid not null references public.property_sensor_devices(id) on delete cascade,
  provider text not null,
  provider_event_id text not null,
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  raw_payload jsonb not null,
  radio_metadata jsonb not null default '{}'::jsonb,
  processing_status text not null default 'received' check (processing_status in ('received','normalized','rejected')),
  rejection_reason text,
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create index if not exists property_telemetry_events_device_time_idx
  on public.property_telemetry_events(device_id, observed_at desc);
create index if not exists property_telemetry_events_property_time_idx
  on public.property_telemetry_events(property_id, observed_at desc);

create table if not exists public.property_telemetry_measurements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  property_id uuid not null references public.physical_properties(id) on delete cascade,
  device_id uuid not null references public.property_sensor_devices(id) on delete cascade,
  event_id uuid not null references public.property_telemetry_events(id) on delete cascade,
  metric_key text not null,
  numeric_value double precision not null,
  unit text not null,
  observed_at timestamptz not null,
  quality text not null default 'raw_sensor' check (quality in ('raw_sensor','calibrated','derived')),
  calibration_version text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (event_id, metric_key)
);

create index if not exists property_telemetry_measurements_device_metric_time_idx
  on public.property_telemetry_measurements(device_id, metric_key, observed_at desc);
create index if not exists property_telemetry_measurements_property_metric_time_idx
  on public.property_telemetry_measurements(property_id, metric_key, observed_at desc);

create or replace view public.property_current_telemetry as
select distinct on (m.device_id, m.metric_key)
  m.id,
  m.workspace_id,
  m.property_id,
  m.device_id,
  m.event_id,
  m.metric_key,
  m.numeric_value,
  m.unit,
  m.observed_at,
  m.quality,
  m.calibration_version,
  m.metadata,
  e.received_at,
  d.device_key,
  d.sensor_kind,
  d.status as device_status,
  d.last_seen_at
from public.property_telemetry_measurements m
join public.property_telemetry_events e on e.id = m.event_id
join public.property_sensor_devices d on d.id = m.device_id
order by m.device_id, m.metric_key, m.observed_at desc, m.created_at desc;

alter table public.property_sensor_devices enable row level security;
alter table public.property_telemetry_events enable row level security;
alter table public.property_telemetry_measurements enable row level security;

comment on table public.property_sensor_devices is
  'Service-role-only registry for physical sensors linked to Property Intelligence entities.';
comment on table public.property_telemetry_events is
  'Immutable raw telemetry ingress. Provider-specific payloads terminate at this boundary.';
comment on table public.property_telemetry_measurements is
  'Provider-agnostic numeric measurements normalized from raw sensor events. Derived values must identify quality/calibration.';
comment on view public.property_current_telemetry is
  'Latest normalized telemetry value per device and metric; not a substitute for historical measurements.';
