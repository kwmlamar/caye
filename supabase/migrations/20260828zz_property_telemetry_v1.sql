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
  unique (workspace_id, device_key)
);

create unique index if not exists property_sensor_devices_provider_identity_idx
  on public.property_sensor_devices(provider, coalesce(provider_application_id, ''), provider_device_id);
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

-- One RPC owns the entire ingest transaction. This prevents a raw event from being committed
-- without its normalized measurements, which would otherwise make a provider retry look like
-- a harmless duplicate and permanently lose the measurement.
create or replace function public.ingest_property_telemetry_event(
  p_provider text,
  p_provider_application_id text,
  p_provider_device_id text,
  p_provider_event_id text,
  p_observed_at timestamptz,
  p_raw_payload jsonb,
  p_radio_metadata jsonb,
  p_metrics jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_device public.property_sensor_devices%rowtype;
  v_event_id uuid;
  v_metric jsonb;
  v_metric_count integer := 0;
begin
  if jsonb_typeof(coalesce(p_metrics, '[]'::jsonb)) <> 'array' then
    raise exception 'p_metrics must be a JSON array';
  end if;

  select * into v_device
  from public.property_sensor_devices
  where provider = p_provider
    and coalesce(provider_application_id, '') = coalesce(p_provider_application_id, '')
    and provider_device_id = p_provider_device_id
  limit 1;

  if not found then
    return jsonb_build_object('status', 'unknown_device');
  end if;

  begin
    insert into public.property_telemetry_events (
      workspace_id,
      property_id,
      device_id,
      provider,
      provider_event_id,
      observed_at,
      raw_payload,
      radio_metadata,
      processing_status
    ) values (
      v_device.workspace_id,
      v_device.property_id,
      v_device.id,
      p_provider,
      p_provider_event_id,
      p_observed_at,
      p_raw_payload,
      coalesce(p_radio_metadata, '{}'::jsonb),
      'received'
    ) returning id into v_event_id;
  exception when unique_violation then
    select id into v_event_id
    from public.property_telemetry_events
    where provider = p_provider and provider_event_id = p_provider_event_id;

    return jsonb_build_object(
      'status', 'duplicate',
      'event_id', v_event_id,
      'metric_count', (
        select count(*)
        from public.property_telemetry_measurements
        where event_id = v_event_id
      )
    );
  end;

  for v_metric in
    select value from jsonb_array_elements(coalesce(p_metrics, '[]'::jsonb))
  loop
    insert into public.property_telemetry_measurements (
      workspace_id,
      property_id,
      device_id,
      event_id,
      metric_key,
      numeric_value,
      unit,
      observed_at,
      quality,
      calibration_version,
      metadata
    ) values (
      v_device.workspace_id,
      v_device.property_id,
      v_device.id,
      v_event_id,
      v_metric->>'metric_key',
      (v_metric->>'numeric_value')::double precision,
      v_metric->>'unit',
      p_observed_at,
      coalesce(v_metric->>'quality', 'raw_sensor'),
      nullif(v_metric->>'calibration_version', ''),
      coalesce(v_metric->'metadata', '{}'::jsonb)
    );
    v_metric_count := v_metric_count + 1;
  end loop;

  if v_metric_count = 0 then
    update public.property_telemetry_events
    set processing_status = 'rejected',
        rejection_reason = 'No supported sensor metrics in decoded payload'
    where id = v_event_id;
  else
    update public.property_telemetry_events
    set processing_status = 'normalized',
        rejection_reason = null
    where id = v_event_id;
  end if;

  -- Never move the heartbeat backwards when delayed uplinks arrive out of order.
  update public.property_sensor_devices
  set last_seen_at = case
        when last_seen_at is null then p_observed_at
        else greatest(last_seen_at, p_observed_at)
      end,
      status = 'active',
      updated_at = now()
  where id = v_device.id;

  return jsonb_build_object(
    'status', 'accepted',
    'event_id', v_event_id,
    'metric_count', v_metric_count
  );
end;
$$;

revoke all on function public.ingest_property_telemetry_event(text, text, text, text, timestamptz, jsonb, jsonb, jsonb) from public;
revoke all on function public.ingest_property_telemetry_event(text, text, text, text, timestamptz, jsonb, jsonb, jsonb) from anon;
revoke all on function public.ingest_property_telemetry_event(text, text, text, text, timestamptz, jsonb, jsonb, jsonb) from authenticated;
grant execute on function public.ingest_property_telemetry_event(text, text, text, text, timestamptz, jsonb, jsonb, jsonb) to service_role;

-- security_invoker is critical here: the view must inherit the caller's RLS context rather
-- than accidentally exposing service-role-only telemetry through the view owner.
create or replace view public.property_current_telemetry
with (security_invoker = true) as
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
  'Raw telemetry ingress. Provider payload and event identity are immutable facts; processing fields may advance inside the atomic ingest transaction.';
comment on table public.property_telemetry_measurements is
  'Provider-agnostic numeric measurements normalized from raw sensor events. Derived values must identify quality/calibration.';
comment on function public.ingest_property_telemetry_event(text, text, text, text, timestamptz, jsonb, jsonb, jsonb) is
  'Service-role-only atomic telemetry ingest: resolve registered device, persist raw event + normalized metrics, and advance heartbeat in one transaction.';
comment on view public.property_current_telemetry is
  'Latest normalized telemetry value per device and metric; security-invoker view, not a substitute for historical measurements.';
