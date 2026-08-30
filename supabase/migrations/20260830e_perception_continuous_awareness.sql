-- Continuous Perception foundation
--
-- Extends workspace_events as the canonical event stream. This migration does NOT
-- introduce a second event bus. perception_source_state is current monitoring state;
-- perception_capability_evidence is a truthful capability/readiness ledger.
--
-- The first end-to-end source is the existing property telemetry webhook/RPC.
-- It observes an explicitly registered device, normalizes provider metrics, correlates
-- them with the previous source state, records only meaningful state changes in
-- workspace_events, and updates freshness/evidence atomically.

create table if not exists public.perception_source_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  source_kind text not null,
  source_identity text not null,
  subject_kind text not null,
  subject_id text not null,
  actor_kind text not null default 'system'
    check (actor_kind in ('outside','caye','operator','system','unknown')),
  actor_id text,
  last_observation_event_id bigint references public.workspace_events(id) on delete set null,
  last_source_event_id text,
  last_fingerprint text,
  last_observed_at timestamptz,
  fresh_until timestamptz,
  confidence numeric(4,3) not null default 1.000
    check (confidence >= 0 and confidence <= 1),
  status text not null default 'unknown'
    check (status in ('unknown','active','stale','error','disabled')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_failure_at timestamptz,
  last_failure_code text,
  retry_after timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_kind, source_identity, subject_kind, subject_id)
);

create index if not exists perception_source_state_workspace_status_idx
  on public.perception_source_state(workspace_id, status, fresh_until);

create table if not exists public.perception_capability_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  capability_key text not null,
  source_kind text not null,
  source_identity text not null,
  status text not null
    check (status in ('foundation','active','limited','future','error')),
  autonomous_now boolean not null default false,
  evidence_event_id bigint references public.workspace_events(id) on delete set null,
  last_observed_at timestamptz,
  fresh_until timestamptz,
  confidence numeric(4,3) not null default 1.000
    check (confidence >= 0 and confidence <= 1),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, capability_key, source_kind, source_identity)
);

create index if not exists perception_capability_evidence_workspace_idx
  on public.perception_capability_evidence(workspace_id, capability_key, status);

-- Observation events are idempotent even if a future source accidentally retries its
-- app-layer write. Existing trigger-derived event types are unaffected.
create unique index if not exists workspace_events_perception_subject_unique_idx
  on public.workspace_events(workspace_id, type, subject_table, subject_id)
  where type like 'observation.%' and subject_table is not null and subject_id is not null;

alter table public.perception_source_state enable row level security;
alter table public.perception_capability_evidence enable row level security;
-- No client policies: service-role writes/reads only. Founder/model access remains behind
-- the authenticated founder capability gateway, preserving workspace + actor isolation.

-- Replace the existing atomic property telemetry ingest with an extension that keeps
-- raw telemetry, normalized measurements, perception state, the canonical workspace
-- event, heartbeat, and capability evidence in ONE transaction.
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
  v_metrics_normalized jsonb := '[]'::jsonb;
  v_fingerprint text;
  v_previous_fingerprint text;
  v_change_kind text;
  v_workspace_event_id bigint;
  v_source_identity text;
  v_fresh_until timestamptz;
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
    -- Authority never expands from perception. Unknown hardware stays unknown.
    return jsonb_build_object('status', 'unknown_device');
  end if;

  begin
    insert into public.property_telemetry_events (
      workspace_id, property_id, device_id, provider, provider_event_id,
      observed_at, raw_payload, radio_metadata, processing_status
    ) values (
      v_device.workspace_id, v_device.property_id, v_device.id, p_provider,
      p_provider_event_id, p_observed_at, p_raw_payload,
      coalesce(p_radio_metadata, '{}'::jsonb), 'received'
    ) returning id into v_event_id;
  exception when unique_violation then
    select id into v_event_id
    from public.property_telemetry_events
    where provider = p_provider and provider_event_id = p_provider_event_id;
    return jsonb_build_object(
      'status', 'duplicate',
      'event_id', v_event_id,
      'metric_count', (
        select count(*) from public.property_telemetry_measurements where event_id = v_event_id
      )
    );
  end;

  for v_metric in
    select value from jsonb_array_elements(coalesce(p_metrics, '[]'::jsonb))
    order by value->>'metric_key'
  loop
    insert into public.property_telemetry_measurements (
      workspace_id, property_id, device_id, event_id, metric_key, numeric_value,
      unit, observed_at, quality, calibration_version, metadata
    ) values (
      v_device.workspace_id, v_device.property_id, v_device.id, v_event_id,
      v_metric->>'metric_key', (v_metric->>'numeric_value')::double precision,
      v_metric->>'unit', p_observed_at, coalesce(v_metric->>'quality', 'raw_sensor'),
      nullif(v_metric->>'calibration_version', ''),
      coalesce(v_metric->'metadata', '{}'::jsonb)
    );
    v_metrics_normalized := v_metrics_normalized || jsonb_build_array(jsonb_build_object(
      'metric_key', v_metric->>'metric_key',
      'numeric_value', (v_metric->>'numeric_value')::double precision,
      'unit', v_metric->>'unit',
      'quality', coalesce(v_metric->>'quality', 'raw_sensor')
    ));
    v_metric_count := v_metric_count + 1;
  end loop;

  if v_metric_count = 0 then
    update public.property_telemetry_events
      set processing_status = 'rejected', rejection_reason = 'No supported sensor metrics in decoded payload'
      where id = v_event_id;
    return jsonb_build_object('status', 'accepted', 'event_id', v_event_id, 'metric_count', 0);
  end if;

  update public.property_telemetry_events
    set processing_status = 'normalized', rejection_reason = null
    where id = v_event_id;

  v_source_identity := p_provider || ':' || coalesce(p_provider_application_id, '') || ':' || p_provider_device_id;
  v_fingerprint := md5(v_metrics_normalized::text);
  v_fresh_until := p_observed_at + interval '15 minutes';

  select last_fingerprint into v_previous_fingerprint
  from public.perception_source_state
  where workspace_id = v_device.workspace_id
    and source_kind = 'property.telemetry'
    and source_identity = v_source_identity
    and subject_kind = 'property_sensor_device'
    and subject_id = v_device.id::text
  for update;

  v_change_kind := case
    when v_previous_fingerprint is null then 'initial'
    when v_previous_fingerprint = v_fingerprint then 'unchanged'
    else 'ordinary_change'
  end;

  -- Record only initial or changed normalized state in the canonical stream. Every raw
  -- uplink remains retained in property_telemetry_events, so dedupe does not erase facts.
  if v_change_kind <> 'unchanged' then
    insert into public.workspace_events (
      workspace_id, occurred_at, type, actor_kind, is_failure, subject_table,
      subject_id, payload, origin
    ) values (
      v_device.workspace_id, p_observed_at, 'observation.property_telemetry', 'system', false,
      'property_telemetry_events', v_event_id::text,
      jsonb_build_object(
        'epistemic_kind', 'observation',
        'change_kind', v_change_kind,
        'anomaly', false,
        'importance', 'routine',
        'severity', 'info',
        'confidence', 1.0,
        'fresh_until', v_fresh_until,
        'source', jsonb_build_object(
          'kind', 'property.telemetry',
          'identity', v_source_identity,
          'provider', p_provider,
          'provider_event_id', p_provider_event_id,
          'device_id', v_device.id,
          'property_id', v_device.property_id
        ),
        'metrics', v_metrics_normalized,
        'fingerprint', v_fingerprint
      ),
      'app'
    ) returning id into v_workspace_event_id;
  end if;

  insert into public.perception_source_state (
    workspace_id, source_kind, source_identity, subject_kind, subject_id,
    actor_kind, actor_id, last_observation_event_id, last_source_event_id,
    last_fingerprint, last_observed_at, fresh_until, confidence, status,
    consecutive_failures, last_failure_at, last_failure_code, retry_after, metadata
  ) values (
    v_device.workspace_id, 'property.telemetry', v_source_identity,
    'property_sensor_device', v_device.id::text, 'system', v_device.id::text,
    v_workspace_event_id, p_provider_event_id, v_fingerprint, p_observed_at,
    v_fresh_until, 1.0, 'active', 0, null, null, null,
    jsonb_build_object('property_id', v_device.property_id, 'device_key', v_device.device_key)
  )
  on conflict (workspace_id, source_kind, source_identity, subject_kind, subject_id)
  do update set
    last_observation_event_id = coalesce(excluded.last_observation_event_id, perception_source_state.last_observation_event_id),
    last_source_event_id = excluded.last_source_event_id,
    last_fingerprint = excluded.last_fingerprint,
    last_observed_at = greatest(coalesce(perception_source_state.last_observed_at, excluded.last_observed_at), excluded.last_observed_at),
    fresh_until = greatest(coalesce(perception_source_state.fresh_until, excluded.fresh_until), excluded.fresh_until),
    confidence = excluded.confidence,
    status = 'active', consecutive_failures = 0, last_failure_at = null,
    last_failure_code = null, retry_after = null, metadata = excluded.metadata,
    updated_at = now();

  insert into public.perception_capability_evidence (
    workspace_id, capability_key, source_kind, source_identity, status,
    autonomous_now, evidence_event_id, last_observed_at, fresh_until,
    confidence, notes, metadata
  ) values (
    v_device.workspace_id, 'perception.continuous_awareness', 'property.telemetry',
    v_source_identity, 'active', true, v_workspace_event_id, p_observed_at,
    v_fresh_until, 1.0,
    'Authorized registered property sensor telemetry is ingested and normalized automatically.',
    jsonb_build_object(
      'observes', true,
      'normalizes', true,
      'correlates', true,
      'detects_change', true,
      'detects_anomaly', false,
      'acts_without_prompt', false,
      'source_event_retained', true
    )
  )
  on conflict (workspace_id, capability_key, source_kind, source_identity)
  do update set
    status = 'active', autonomous_now = true,
    evidence_event_id = coalesce(excluded.evidence_event_id, perception_capability_evidence.evidence_event_id),
    last_observed_at = greatest(coalesce(perception_capability_evidence.last_observed_at, excluded.last_observed_at), excluded.last_observed_at),
    fresh_until = greatest(coalesce(perception_capability_evidence.fresh_until, excluded.fresh_until), excluded.fresh_until),
    confidence = excluded.confidence, notes = excluded.notes, metadata = excluded.metadata,
    updated_at = now();

  update public.property_sensor_devices
    set last_seen_at = case when last_seen_at is null then p_observed_at else greatest(last_seen_at, p_observed_at) end,
        status = 'active', updated_at = now()
    where id = v_device.id;

  return jsonb_build_object(
    'status', 'accepted',
    'event_id', v_event_id,
    'workspace_event_id', v_workspace_event_id,
    'metric_count', v_metric_count,
    'change_kind', v_change_kind
  );
end;
$$;

revoke all on function public.ingest_property_telemetry_event(text, text, text, text, timestamptz, jsonb, jsonb, jsonb) from public;
revoke all on function public.ingest_property_telemetry_event(text, text, text, text, timestamptz, jsonb, jsonb, jsonb) from anon;
revoke all on function public.ingest_property_telemetry_event(text, text, text, text, timestamptz, jsonb, jsonb, jsonb) from authenticated;
grant execute on function public.ingest_property_telemetry_event(text, text, text, text, timestamptz, jsonb, jsonb, jsonb) to service_role;

comment on table public.perception_source_state is
  'Current workspace-scoped monitoring state for authorized perception sources. Not an event log; canonical facts remain in workspace_events/source tables.';
comment on table public.perception_capability_evidence is
  'Truthful evidence of what perception sources are autonomous now versus limited/future, for Direction and founder capability reads.';
