-- External domain event projection bridge.
-- Bedrock/domain systems remain authoritative. Caye stores only ingestion state and
-- normalized operational events in the existing workspace_events stream.

create table if not exists public.domain_sync_cursors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  source_system text not null,
  source_company_id text not null,
  stream text not null,
  cursor jsonb,
  watermark timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_system, source_company_id, stream)
);

create table if not exists public.domain_entity_observation_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  source_system text not null,
  source_company_id text not null,
  source_entity_type text not null,
  source_entity_id text not null,
  caye_entity_id text,
  last_source_version text,
  last_occurred_at timestamptz not null,
  last_observed_at timestamptz not null,
  last_idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_system, source_company_id, source_entity_type, source_entity_id)
);

-- Domain events do not use the observation.* subject uniqueness rule because one entity can
-- legitimately transition many times. Source identity is the event-level uniqueness boundary.
create unique index if not exists workspace_events_domain_idempotency_unique_idx
  on public.workspace_events (
    workspace_id,
    (payload #>> '{source,system}'),
    (payload #>> '{source,idempotency_key}')
  )
  where type like 'domain.%'
    and payload #>> '{source,system}' is not null
    and payload #>> '{source,idempotency_key}' is not null;

alter table public.domain_sync_cursors enable row level security;
alter table public.domain_entity_observation_state enable row level security;
revoke all on table public.domain_sync_cursors from public, anon, authenticated;
revoke all on table public.domain_entity_observation_state from public, anon, authenticated;
grant select, insert, update, delete on table public.domain_sync_cursors to service_role;
grant select, insert, update, delete on table public.domain_entity_observation_state to service_role;

create or replace function public.ingest_external_domain_event(
  p_workspace_id uuid,
  p_source_system text,
  p_source_company_id text,
  p_source_entity_type text,
  p_source_entity_id text,
  p_caye_entity_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_observed_at timestamptz,
  p_idempotency_key text,
  p_source_version text,
  p_actor_kind text,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state public.domain_entity_observation_state%rowtype;
  v_workspace_event_id bigint;
  v_existing_event_id bigint;
  v_subject_id text;
  v_payload jsonb;
begin
  if p_workspace_id is null or nullif(trim(p_source_system), '') is null
    or nullif(trim(p_source_company_id), '') is null
    or nullif(trim(p_source_entity_type), '') is null
    or nullif(trim(p_source_entity_id), '') is null
    or nullif(trim(p_event_type), '') is null
    or p_event_type not like 'domain.%'
    or p_occurred_at is null or p_observed_at is null
    or nullif(trim(p_idempotency_key), '') is null then
    raise exception 'Malformed external domain event';
  end if;

  if p_observed_at < p_occurred_at - interval '5 minutes' then
    raise exception 'observed_at materially precedes occurred_at';
  end if;

  -- Serialize retries and concurrent scans for the same deterministic event identity.
  perform pg_advisory_xact_lock(hashtextextended(
    p_workspace_id::text || ':' || p_source_system || ':' || p_idempotency_key,
    0
  ));

  select id into v_existing_event_id
    from public.workspace_events
   where workspace_id = p_workspace_id
     and type like 'domain.%'
     and payload #>> '{source,system}' = p_source_system
     and payload #>> '{source,idempotency_key}' = p_idempotency_key
   limit 1;

  if v_existing_event_id is not null then
    return jsonb_build_object('status', 'duplicate', 'workspace_event_id', v_existing_event_id);
  end if;

  select * into v_state
    from public.domain_entity_observation_state
   where workspace_id = p_workspace_id
     and source_system = p_source_system
     and source_company_id = p_source_company_id
     and source_entity_type = p_source_entity_type
     and source_entity_id = p_source_entity_id
   for update;

  if found and p_occurred_at < v_state.last_occurred_at then
    -- Delayed data remains available in the domain system. It must not masquerade as a
    -- new change in Caye's current operational stream.
    return jsonb_build_object('status', 'stale', 'last_occurred_at', v_state.last_occurred_at);
  end if;

  v_subject_id := p_source_system || ':' || p_source_entity_type || ':' || p_source_entity_id;
  v_payload := coalesce(p_payload, '{}'::jsonb) || jsonb_build_object(
    'epistemic_kind', 'operational_event',
    'observed_at', p_observed_at,
    'source', coalesce(coalesce(p_payload, '{}'::jsonb)->'source', '{}'::jsonb) || jsonb_build_object(
      'system', p_source_system,
      'company_id', p_source_company_id,
      'entity_type', p_source_entity_type,
      'entity_id', p_source_entity_id,
      'version', p_source_version,
      'idempotency_key', p_idempotency_key
    ),
    'entity', coalesce(coalesce(p_payload, '{}'::jsonb)->'entity', '{}'::jsonb) || jsonb_build_object(
      'caye_entity_id', p_caye_entity_id,
      'resolution', case when p_caye_entity_id is null then 'unresolved' else 'resolved' end
    )
  );

  insert into public.workspace_events (
    workspace_id, occurred_at, type, actor_kind, is_failure,
    subject_table, subject_id, payload, origin
  ) values (
    p_workspace_id, p_occurred_at, p_event_type,
    case when p_actor_kind in ('outside','caye','operator','system','unknown') then p_actor_kind else 'unknown' end,
    false, 'external_domain_entity', v_subject_id, v_payload, 'app'
  )
  on conflict do nothing
  returning id into v_workspace_event_id;

  if v_workspace_event_id is null then
    select id into v_workspace_event_id
      from public.workspace_events
     where workspace_id = p_workspace_id
       and type like 'domain.%'
       and payload #>> '{source,system}' = p_source_system
       and payload #>> '{source,idempotency_key}' = p_idempotency_key
     limit 1;
    return jsonb_build_object('status', 'duplicate', 'workspace_event_id', v_workspace_event_id);
  end if;

  insert into public.domain_entity_observation_state (
    workspace_id, source_system, source_company_id, source_entity_type, source_entity_id,
    caye_entity_id, last_source_version, last_occurred_at, last_observed_at,
    last_idempotency_key, metadata
  ) values (
    p_workspace_id, p_source_system, p_source_company_id, p_source_entity_type, p_source_entity_id,
    p_caye_entity_id, p_source_version, p_occurred_at, p_observed_at,
    p_idempotency_key, jsonb_build_object('workspace_event_id', v_workspace_event_id)
  )
  on conflict (workspace_id, source_system, source_company_id, source_entity_type, source_entity_id)
  do update set
    caye_entity_id = coalesce(excluded.caye_entity_id, domain_entity_observation_state.caye_entity_id),
    last_source_version = excluded.last_source_version,
    last_occurred_at = greatest(domain_entity_observation_state.last_occurred_at, excluded.last_occurred_at),
    last_observed_at = greatest(domain_entity_observation_state.last_observed_at, excluded.last_observed_at),
    last_idempotency_key = excluded.last_idempotency_key,
    metadata = excluded.metadata,
    updated_at = now();

  return jsonb_build_object('status', 'inserted', 'workspace_event_id', v_workspace_event_id);
end;
$$;

revoke all on function public.ingest_external_domain_event(
  uuid,text,text,text,text,text,text,timestamptz,timestamptz,text,text,text,jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_external_domain_event(
  uuid,text,text,text,text,text,text,timestamptz,timestamptz,text,text,text,jsonb
) to service_role;

comment on table public.domain_sync_cursors is
  'Durable replay cursor for polling external domain adapters. Contains no authoritative domain rows.';
comment on table public.domain_entity_observation_state is
  'Monotonic ingestion watermark for external domain entities. Stores projection metadata only, never authoritative business state.';
comment on function public.ingest_external_domain_event is
  'Idempotently projects a normalized external operational event into workspace_events while suppressing stale current-state updates.';
