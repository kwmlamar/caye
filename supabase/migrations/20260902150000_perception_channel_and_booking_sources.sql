-- Perception: channel messaging activity (email/WhatsApp/Instagram/Messenger) and
-- booking state as normalized observation sources.
--
-- Extends the Perception & Continuous Awareness foundation
-- (20260830e_perception_continuous_awareness.sql) with two more end-to-end sources.
-- This does NOT introduce a second event bus. Both sources read directly from the
-- existing canonical workspace_events stream, which is already trigger-backed for:
--
--   - inbound customer messages on every channel (unified_messages ->
--     trg_caye_event_unified_message -> workspace_events type 'message.inbound',
--     covering Gmail, Zoho, WhatsApp — including coexistence-observed activity —
--     Instagram and Messenger uniformly through unified_conversations.channel_type);
--   - booking creation/status changes (bookings -> trg_caye_event_booking ->
--     workspace_events types 'booking.created' / 'booking.status_changed').
--
-- Calendar ingestion was evaluated and deliberately left out of this migration: no
-- trigger promotes calendar sync writes into workspace_events today, so wiring it
-- here would mean inventing a new parallel special-case ingestion path rather than
-- normalizing an already-canonical one. That is future work, not silently claimed.
--
-- Both new observers follow the exact pattern already established by
-- observe_workspace_event_stream / ingest_property_telemetry_event: normalize,
-- correlate with prior perception_source_state, write a canonical
-- 'observation.*' event ONLY for initial/changed state, and update source
-- freshness/capability evidence in the same transaction. Perception writes state
-- and evidence only — no message is sent, no booking is changed, no tool
-- permission is granted.

-- ---------------------------------------------------------------------------
-- 1. Channel messaging activity
-- ---------------------------------------------------------------------------
--
-- Source identity is the connected_account (stable, workspace-scoped, provider-
-- authenticated at connect time). Subject is the conversation, so a workspace with
-- several active customer threads on the same channel gets independent current
-- state per thread rather than one lossy per-channel blob. Only genuinely new
-- inbound customer activity is observed — Caye's own outbound sends are actions
-- already recorded elsewhere, not new external signal to perceive.

create or replace function public.observe_channel_message_activity(
  p_conversation_id uuid,
  p_observed_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_latest public.workspace_events%rowtype;
  v_channel_type text;
  v_connected_account_id uuid;
  v_customer_name text;
  v_source_kind text;
  v_source_identity text;
  v_fingerprint text;
  v_previous_fingerprint text;
  v_previous_observed_at timestamptz;
  v_change_kind text;
  v_observation_event_id bigint;
  v_fresh_until timestamptz;
  v_server_now timestamptz := now();
begin
  if p_conversation_id is null then
    return jsonb_build_object('status', 'malformed_observation', 'reason', 'conversation_id_required');
  end if;

  if p_observed_at is null then
    return jsonb_build_object('status', 'malformed_observation', 'reason', 'observed_at_required');
  end if;

  -- Service-role authority does not imply authority to move the durable perception
  -- clock arbitrarily. Mirrors observe_workspace_event_stream's clock guard.
  if p_observed_at > v_server_now + interval '5 minutes' then
    return jsonb_build_object(
      'status', 'future_observation',
      'reason', 'observed_at_too_far_in_future',
      'attempted_observed_at', p_observed_at,
      'server_now', v_server_now
    );
  end if;

  select *
    into v_latest
    from public.workspace_events
   where conversation_id = p_conversation_id
     and type = 'message.inbound'
   order by id desc
   limit 1;

  if not found then
    return jsonb_build_object('status', 'missing_source', 'reason', 'no_inbound_message', 'conversation_id', p_conversation_id);
  end if;

  select channel_type::text, connected_account_id, customer_name
    into v_channel_type, v_connected_account_id, v_customer_name
    from public.unified_conversations
   where id = p_conversation_id;

  if v_channel_type is null or v_connected_account_id is null then
    -- An orphaned/unresolvable conversation is not enrolled as a source. Losing
    -- this observation is strictly better than guessing its channel identity.
    return jsonb_build_object('status', 'missing_source', 'reason', 'conversation_channel_unresolved');
  end if;

  v_source_kind := 'channel.' || v_channel_type;
  v_source_identity := v_connected_account_id::text;

  select last_fingerprint, last_observed_at
    into v_previous_fingerprint, v_previous_observed_at
    from public.perception_source_state
   where workspace_id = v_latest.workspace_id
     and source_kind = v_source_kind
     and source_identity = v_source_identity
     and subject_kind = 'unified_conversation'
     and subject_id = p_conversation_id::text
   for update;

  if v_previous_observed_at is not null and p_observed_at < v_previous_observed_at then
    return jsonb_build_object(
      'status', 'stale',
      'last_observed_at', v_previous_observed_at,
      'attempted_observed_at', p_observed_at
    );
  end if;

  -- The message itself is the unit of change: each new canonical inbound message
  -- id is by definition a new fact, so the fingerprint is simply "have we already
  -- correlated this source event." No content is re-derived or reinterpreted here.
  v_fingerprint := md5(v_latest.id::text);

  v_change_kind := case
    when v_previous_fingerprint is null then 'initial'
    when v_previous_fingerprint = v_fingerprint then 'unchanged'
    else 'ordinary_change'
  end;

  v_fresh_until := p_observed_at + interval '15 minutes';

  if v_change_kind <> 'unchanged' then
    insert into public.workspace_events (
      workspace_id, occurred_at, type, actor_kind, is_failure, subject_table,
      subject_id, conversation_id, payload, origin
    ) values (
      v_latest.workspace_id, p_observed_at, 'observation.channel_activity', 'system', false,
      'unified_messages', v_latest.subject_id, p_conversation_id,
      jsonb_build_object(
        'epistemic_kind', 'observation',
        'change_kind', v_change_kind,
        'anomaly', false,
        'importance', 'routine',
        'severity', 'info',
        'confidence', 1.0,
        'fresh_until', v_fresh_until,
        'source', jsonb_build_object(
          'kind', v_source_kind,
          'identity', v_source_identity,
          'channel_type', v_channel_type,
          'connected_account_id', v_connected_account_id,
          'conversation_id', p_conversation_id,
          'source_event_id', v_latest.id
        ),
        'state', jsonb_build_object(
          'customer', v_customer_name,
          'latest_message_preview', v_latest.payload ->> 'preview',
          'latest_message_occurred_at', v_latest.occurred_at
        ),
        'fingerprint', v_fingerprint
      ),
      'app'
    )
    on conflict do nothing
    returning id into v_observation_event_id;

    if v_observation_event_id is null then
      select id
        into v_observation_event_id
        from public.workspace_events
       where workspace_id = v_latest.workspace_id
         and type = 'observation.channel_activity'
         and subject_table = 'unified_messages'
         and subject_id = v_latest.subject_id
       limit 1;
    end if;
  end if;

  insert into public.perception_source_state (
    workspace_id, source_kind, source_identity, subject_kind, subject_id,
    actor_kind, actor_id, last_observation_event_id, last_source_event_id,
    last_fingerprint, last_observed_at, fresh_until, confidence, status,
    consecutive_failures, last_failure_at, last_failure_code, retry_after, metadata
  ) values (
    v_latest.workspace_id, v_source_kind, v_source_identity, 'unified_conversation', p_conversation_id::text,
    'system', v_connected_account_id::text, v_observation_event_id, v_latest.id::text,
    v_fingerprint, p_observed_at, v_fresh_until, 1.0, 'active', 0, null, null, null,
    jsonb_build_object('channel_type', v_channel_type, 'connected_account_id', v_connected_account_id)
  )
  on conflict (workspace_id, source_kind, source_identity, subject_kind, subject_id)
  do update set
    last_observation_event_id = coalesce(excluded.last_observation_event_id, perception_source_state.last_observation_event_id),
    last_source_event_id = excluded.last_source_event_id,
    last_fingerprint = excluded.last_fingerprint,
    last_observed_at = excluded.last_observed_at,
    fresh_until = excluded.fresh_until,
    confidence = excluded.confidence,
    status = 'active', consecutive_failures = 0, last_failure_at = null,
    last_failure_code = null, retry_after = null, metadata = excluded.metadata,
    updated_at = now();

  insert into public.perception_capability_evidence (
    workspace_id, capability_key, source_kind, source_identity, status,
    autonomous_now, evidence_event_id, last_observed_at, fresh_until,
    confidence, notes, metadata
  ) values (
    v_latest.workspace_id, 'perception.continuous_awareness', v_source_kind, v_source_identity, 'active',
    true, v_observation_event_id, p_observed_at, v_fresh_until, 1.0,
    'Authorized channel messaging activity is observed and normalized from the canonical message stream. Perception never replies.',
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
    last_observed_at = excluded.last_observed_at,
    fresh_until = excluded.fresh_until,
    confidence = excluded.confidence, notes = excluded.notes, metadata = excluded.metadata,
    updated_at = now();

  return jsonb_build_object(
    'status', 'accepted',
    'workspace_id', v_latest.workspace_id,
    'conversation_id', p_conversation_id,
    'source_kind', v_source_kind,
    'source_event_id', v_latest.id,
    'observation_event_id', v_observation_event_id,
    'change_kind', v_change_kind,
    'anomaly', false,
    'fresh_until', v_fresh_until
  );
end;
$$;

create or replace function public.run_channel_activity_perception_cycle(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source record;
  v_result jsonb;
  v_processed integer := 0;
  v_changed integer := 0;
  v_unchanged integer := 0;
  v_failed integer := 0;
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  for v_source in
    select conversation_id, occurred_at
      from (
        select distinct on (conversation_id)
               conversation_id, id, occurred_at
          from public.workspace_events
         where type = 'message.inbound'
           and conversation_id is not null
         order by conversation_id, id desc
      ) latest_by_conversation
     order by occurred_at desc, id desc
     limit v_limit
  loop
    begin
      v_result := public.observe_channel_message_activity(v_source.conversation_id, now());
      v_processed := v_processed + 1;
      if coalesce(v_result ->> 'change_kind', '') = 'unchanged' then
        v_unchanged := v_unchanged + 1;
      elsif coalesce(v_result ->> 'status', '') = 'accepted' then
        v_changed := v_changed + 1;
      else
        v_failed := v_failed + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object(
    'status', case when v_failed = 0 then 'ok' else 'partial_failure' end,
    'processed', v_processed,
    'changed', v_changed,
    'unchanged', v_unchanged,
    'failed', v_failed,
    'limit', v_limit
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Booking state
-- ---------------------------------------------------------------------------
--
-- Reads directly from the already-canonical booking.created / booking.status_changed
-- events (trg_caye_event_booking) rather than re-querying public.bookings, so the
-- observation is always correlated against the same immutable fact the rest of the
-- system already treats as authoritative history. Source identity is constant
-- ('bookings') per workspace; subject is the individual booking.

create or replace function public.observe_booking_state(
  p_booking_id text,
  p_observed_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_latest public.workspace_events%rowtype;
  v_status text;
  v_source_kind text := 'booking.state';
  v_source_identity text := 'bookings';
  v_fingerprint text;
  v_previous_fingerprint text;
  v_previous_observed_at timestamptz;
  v_change_kind text;
  v_observation_event_id bigint;
  v_fresh_until timestamptz;
  v_importance text;
  v_severity text;
  v_server_now timestamptz := now();
begin
  if p_booking_id is null or length(trim(p_booking_id)) = 0 then
    return jsonb_build_object('status', 'malformed_observation', 'reason', 'booking_id_required');
  end if;

  if p_observed_at is null then
    return jsonb_build_object('status', 'malformed_observation', 'reason', 'observed_at_required');
  end if;

  if p_observed_at > v_server_now + interval '5 minutes' then
    return jsonb_build_object(
      'status', 'future_observation',
      'reason', 'observed_at_too_far_in_future',
      'attempted_observed_at', p_observed_at,
      'server_now', v_server_now
    );
  end if;

  select *
    into v_latest
    from public.workspace_events
   where subject_table = 'bookings'
     and subject_id = p_booking_id
     and type in ('booking.created', 'booking.status_changed')
   order by id desc
   limit 1;

  if not found then
    return jsonb_build_object('status', 'missing_source', 'reason', 'no_booking_event', 'booking_id', p_booking_id);
  end if;

  v_status := coalesce(v_latest.payload ->> 'to', v_latest.payload ->> 'status');

  select last_fingerprint, last_observed_at
    into v_previous_fingerprint, v_previous_observed_at
    from public.perception_source_state
   where workspace_id = v_latest.workspace_id
     and source_kind = v_source_kind
     and source_identity = v_source_identity
     and subject_kind = 'booking'
     and subject_id = p_booking_id
   for update;

  if v_previous_observed_at is not null and p_observed_at < v_previous_observed_at then
    return jsonb_build_object(
      'status', 'stale',
      'last_observed_at', v_previous_observed_at,
      'attempted_observed_at', p_observed_at
    );
  end if;

  v_fingerprint := md5(
    coalesce(v_status, '') || '|' ||
    coalesce(v_latest.payload ->> 'booking_date', '') || '|' ||
    coalesce(v_latest.payload ->> 'customer', '')
  );

  v_change_kind := case
    when v_previous_fingerprint is null then 'initial'
    when v_previous_fingerprint = v_fingerprint then 'unchanged'
    else 'ordinary_change'
  end;

  v_fresh_until := p_observed_at + interval '60 minutes';

  -- Importance classification only — input for a future, separately-authorized
  -- attention policy. Never anomaly detection, never a send/mutate trigger.
  if v_change_kind = 'initial' then
    v_importance := 'notice';
    v_severity := 'info';
  elsif v_change_kind = 'ordinary_change' and v_status in ('cancelled', 'no_show') then
    v_importance := 'notice';
    v_severity := 'warning';
  else
    v_importance := 'routine';
    v_severity := 'info';
  end if;

  if v_change_kind <> 'unchanged' then
    insert into public.workspace_events (
      workspace_id, occurred_at, type, actor_kind, is_failure, subject_table,
      subject_id, conversation_id, payload, origin
    ) values (
      v_latest.workspace_id, p_observed_at, 'observation.booking_state', 'system', false,
      'bookings', p_booking_id, v_latest.conversation_id,
      jsonb_build_object(
        'epistemic_kind', 'observation',
        'change_kind', v_change_kind,
        'anomaly', false,
        'importance', v_importance,
        'severity', v_severity,
        'confidence', 1.0,
        'fresh_until', v_fresh_until,
        'source', jsonb_build_object(
          'kind', v_source_kind,
          'identity', v_source_identity,
          'booking_id', p_booking_id,
          'source_event_id', v_latest.id,
          'source_event_type', v_latest.type
        ),
        'state', jsonb_build_object(
          'status', v_status,
          'customer', v_latest.payload ->> 'customer',
          'booking_date', v_latest.payload ->> 'booking_date'
        ),
        'fingerprint', v_fingerprint
      ),
      'app'
    )
    on conflict do nothing
    returning id into v_observation_event_id;

    if v_observation_event_id is null then
      select id
        into v_observation_event_id
        from public.workspace_events
       where workspace_id = v_latest.workspace_id
         and type = 'observation.booking_state'
         and subject_table = 'bookings'
         and subject_id = p_booking_id
       limit 1;
    end if;
  end if;

  insert into public.perception_source_state (
    workspace_id, source_kind, source_identity, subject_kind, subject_id,
    actor_kind, actor_id, last_observation_event_id, last_source_event_id,
    last_fingerprint, last_observed_at, fresh_until, confidence, status,
    consecutive_failures, last_failure_at, last_failure_code, retry_after, metadata
  ) values (
    v_latest.workspace_id, v_source_kind, v_source_identity, 'booking', p_booking_id,
    'system', p_booking_id, v_observation_event_id, v_latest.id::text,
    v_fingerprint, p_observed_at, v_fresh_until, 1.0, 'active', 0, null, null, null,
    jsonb_build_object('status', v_status)
  )
  on conflict (workspace_id, source_kind, source_identity, subject_kind, subject_id)
  do update set
    last_observation_event_id = coalesce(excluded.last_observation_event_id, perception_source_state.last_observation_event_id),
    last_source_event_id = excluded.last_source_event_id,
    last_fingerprint = excluded.last_fingerprint,
    last_observed_at = excluded.last_observed_at,
    fresh_until = excluded.fresh_until,
    confidence = excluded.confidence,
    status = 'active', consecutive_failures = 0, last_failure_at = null,
    last_failure_code = null, retry_after = null, metadata = excluded.metadata,
    updated_at = now();

  insert into public.perception_capability_evidence (
    workspace_id, capability_key, source_kind, source_identity, status,
    autonomous_now, evidence_event_id, last_observed_at, fresh_until,
    confidence, notes, metadata
  ) values (
    v_latest.workspace_id, 'perception.continuous_awareness', v_source_kind, v_source_identity, 'active',
    true, v_observation_event_id, p_observed_at, v_fresh_until, 1.0,
    'Authorized booking state changes are observed and normalized from the canonical booking event stream. Perception never changes a booking.',
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
    last_observed_at = excluded.last_observed_at,
    fresh_until = excluded.fresh_until,
    confidence = excluded.confidence, notes = excluded.notes, metadata = excluded.metadata,
    updated_at = now();

  return jsonb_build_object(
    'status', 'accepted',
    'workspace_id', v_latest.workspace_id,
    'booking_id', p_booking_id,
    'source_event_id', v_latest.id,
    'observation_event_id', v_observation_event_id,
    'change_kind', v_change_kind,
    'anomaly', false,
    'importance', v_importance,
    'severity', v_severity,
    'fresh_until', v_fresh_until
  );
end;
$$;

create or replace function public.run_booking_state_perception_cycle(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source record;
  v_result jsonb;
  v_processed integer := 0;
  v_changed integer := 0;
  v_unchanged integer := 0;
  v_failed integer := 0;
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  for v_source in
    select subject_id as booking_id, occurred_at
      from (
        select distinct on (subject_id)
               subject_id, id, occurred_at
          from public.workspace_events
         where type in ('booking.created', 'booking.status_changed')
           and subject_table = 'bookings'
           and subject_id is not null
         order by subject_id, id desc
      ) latest_by_booking
     order by occurred_at desc, id desc
     limit v_limit
  loop
    begin
      v_result := public.observe_booking_state(v_source.booking_id, now());
      v_processed := v_processed + 1;
      if coalesce(v_result ->> 'change_kind', '') = 'unchanged' then
        v_unchanged := v_unchanged + 1;
      elsif coalesce(v_result ->> 'status', '') = 'accepted' then
        v_changed := v_changed + 1;
      else
        v_failed := v_failed + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object(
    'status', case when v_failed = 0 then 'ok' else 'partial_failure' end,
    'processed', v_processed,
    'changed', v_changed,
    'unchanged', v_unchanged,
    'failed', v_failed,
    'limit', v_limit
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Fold both sources into the existing bounded cron entrypoint
-- ---------------------------------------------------------------------------
--
-- app/api/caye/perception-awareness/route.ts already calls exactly this RPC name
-- on a 10-minute schedule. Redefining it here (same signature, same name) is the
-- same evolution pattern 20260830_perception_timestamp_failure_hardening.sql used
-- for observe_workspace_event_stream: no app-layer change, no new cron wiring, and
-- the generic whole-workspace observer keeps running exactly as before alongside
-- the two new differentiated sources.

create or replace function public.run_workspace_event_perception_cycle(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source record;
  v_result jsonb;
  v_processed integer := 0;
  v_changed integer := 0;
  v_unchanged integer := 0;
  v_failed integer := 0;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_channel_result jsonb;
  v_booking_result jsonb;
begin
  for v_source in
    select workspace_id, id, occurred_at, type
      from (
        select distinct on (workspace_id)
               workspace_id, id, occurred_at, type
          from public.workspace_events
         where type not like 'observation.%'
         order by workspace_id, id desc
      ) latest_by_workspace
     order by occurred_at desc, id desc
     limit v_limit
  loop
    begin
      v_result := public.observe_workspace_event_stream(v_source.workspace_id, now());
      v_processed := v_processed + 1;
      if coalesce(v_result ->> 'change_kind', '') = 'unchanged' then
        v_unchanged := v_unchanged + 1;
      elsif coalesce(v_result ->> 'status', '') = 'accepted' then
        v_changed := v_changed + 1;
      else
        v_failed := v_failed + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;

      insert into public.perception_source_state(
        workspace_id,source_kind,source_identity,subject_kind,subject_id,actor_kind,
        last_source_event_id,last_observed_at,fresh_until,confidence,status,
        consecutive_failures,last_failure_at,last_failure_code,retry_after,metadata
      ) values(
        v_source.workspace_id,'system.workspace_event_stream','workspace_events','workspace_event_stream',
        v_source.workspace_id::text,'system',v_source.id::text,null,now(),0,'degraded',
        1,now(),'observer_error',now()+interval '5 minutes',
        jsonb_build_object(
          'failed_source_event_type',v_source.type,
          'failed_source_event_occurred_at',v_source.occurred_at
        )
      )
      on conflict(workspace_id,source_kind,source_identity,subject_kind,subject_id)
      do update set
        status='degraded',
        consecutive_failures=perception_source_state.consecutive_failures+1,
        last_failure_at=now(),
        last_failure_code='observer_error',
        retry_after=now()+interval '5 minutes',
        last_source_event_id=excluded.last_source_event_id,
        metadata=perception_source_state.metadata || excluded.metadata,
        updated_at=now();
    end;
  end loop;

  v_channel_result := public.run_channel_activity_perception_cycle(v_limit);
  v_booking_result := public.run_booking_state_perception_cycle(v_limit);

  v_processed := v_processed + coalesce((v_channel_result->>'processed')::integer, 0)
                              + coalesce((v_booking_result->>'processed')::integer, 0);
  v_changed := v_changed + coalesce((v_channel_result->>'changed')::integer, 0)
                          + coalesce((v_booking_result->>'changed')::integer, 0);
  v_unchanged := v_unchanged + coalesce((v_channel_result->>'unchanged')::integer, 0)
                              + coalesce((v_booking_result->>'unchanged')::integer, 0);
  v_failed := v_failed + coalesce((v_channel_result->>'failed')::integer, 0)
                        + coalesce((v_booking_result->>'failed')::integer, 0);

  return jsonb_build_object(
    'status',case when v_failed=0 then 'ok' else 'partial_failure' end,
    'processed',v_processed,
    'changed',v_changed,
    'unchanged',v_unchanged,
    'failed',v_failed,
    'limit',v_limit,
    'sources', jsonb_build_object(
      'workspace_event_stream', jsonb_build_object('limit', v_limit),
      'channel_activity', v_channel_result,
      'booking_state', v_booking_result
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Indexes for the bounded scans above
-- ---------------------------------------------------------------------------

create index if not exists workspace_events_message_inbound_conversation_idx
  on public.workspace_events (conversation_id, id desc)
  where type = 'message.inbound' and conversation_id is not null;

create index if not exists workspace_events_booking_state_subject_idx
  on public.workspace_events (subject_id, id desc)
  where type in ('booking.created', 'booking.status_changed') and subject_table = 'bookings';

-- ---------------------------------------------------------------------------
-- 5. Authority — service-role only, matching every other perception RPC
-- ---------------------------------------------------------------------------

revoke all on function public.observe_channel_message_activity(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.observe_channel_message_activity(uuid, timestamptz) to service_role;

revoke all on function public.run_channel_activity_perception_cycle(integer) from public, anon, authenticated;
grant execute on function public.run_channel_activity_perception_cycle(integer) to service_role;

revoke all on function public.observe_booking_state(text, timestamptz) from public, anon, authenticated;
grant execute on function public.observe_booking_state(text, timestamptz) to service_role;

revoke all on function public.run_booking_state_perception_cycle(integer) from public, anon, authenticated;
grant execute on function public.run_booking_state_perception_cycle(integer) to service_role;

revoke all on function public.run_workspace_event_perception_cycle(integer) from public, anon, authenticated;
grant execute on function public.run_workspace_event_perception_cycle(integer) to service_role;

comment on function public.observe_channel_message_activity(uuid, timestamptz) is
  'Normalizes canonical inbound-message activity (email/WhatsApp/Instagram/Messenger, via unified_messages -> workspace_events) into perception_source_state/workspace_events observation.channel_activity. Read-and-record only; never sends.';
comment on function public.observe_booking_state(text, timestamptz) is
  'Normalizes canonical booking.created/booking.status_changed events into perception_source_state/workspace_events observation.booking_state. Read-and-record only; never mutates a booking.';
