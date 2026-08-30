-- Promote the already-canonical workspace event stream into the production perception control plane.
-- This does not create a second event bus. It observes the existing workspace_events stream.

create or replace function public.observe_workspace_event_stream(
  p_workspace_id uuid,
  p_observed_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_latest public.workspace_events%rowtype;
  v_event_count bigint;
  v_failure_count bigint;
  v_fingerprint text;
  v_previous_fingerprint text;
  v_previous_observed_at timestamptz;
  v_change_kind text;
  v_observation_event_id bigint;
  v_fresh_until timestamptz;
  v_status text;
  v_anomaly boolean;
  v_importance text;
  v_severity text;
begin
  if p_workspace_id is null then
    return jsonb_build_object('status', 'malformed_observation', 'reason', 'workspace_id_required');
  end if;

  select * into v_latest
    from public.workspace_events
   where workspace_id = p_workspace_id
     and type not like 'observation.%'
   order by id desc
   limit 1;

  if not found then
    return jsonb_build_object('status', 'missing_source', 'workspace_id', p_workspace_id);
  end if;

  select count(*)::bigint,
         count(*) filter (where is_failure)::bigint
    into v_event_count, v_failure_count
    from public.workspace_events
   where workspace_id = p_workspace_id
     and type not like 'observation.%';

  select last_fingerprint, last_observed_at
    into v_previous_fingerprint, v_previous_observed_at
    from public.perception_source_state
   where workspace_id = p_workspace_id
     and source_kind = 'system.workspace_event_stream'
     and source_identity = 'workspace_events'
     and subject_kind = 'workspace_event_stream'
     and subject_id = p_workspace_id::text
   for update;

  if v_previous_observed_at is not null and p_observed_at < v_previous_observed_at then
    return jsonb_build_object(
      'status', 'stale',
      'last_observed_at', v_previous_observed_at,
      'attempted_observed_at', p_observed_at
    );
  end if;

  v_fingerprint := md5(jsonb_build_object(
    'latest_event_id', v_latest.id,
    'latest_event_type', v_latest.type,
    'event_count', v_event_count,
    'failure_count', v_failure_count
  )::text);

  v_change_kind := case
    when v_previous_fingerprint is null then 'initial'
    when v_previous_fingerprint = v_fingerprint then 'unchanged'
    else 'ordinary_change'
  end;

  -- A database-backed stream can be observed now even when the workspace is naturally quiet.
  -- We do not infer user/business anomalies from inactivity here.
  v_anomaly := false;
  v_importance := 'routine';
  v_severity := 'info';
  v_status := 'active';
  v_fresh_until := p_observed_at + interval '15 minutes';

  if v_change_kind <> 'unchanged' then
    insert into public.workspace_events (
      workspace_id, occurred_at, type, actor_kind, is_failure,
      subject_table, subject_id, payload, origin
    ) values (
      p_workspace_id,
      p_observed_at,
      'observation.workspace_event_stream',
      'system',
      false,
      'perception_source_state',
      'workspace_events:' || p_workspace_id::text,
      jsonb_build_object(
        'epistemic_kind', 'observation',
        'change_kind', v_change_kind,
        'anomaly', v_anomaly,
        'importance', v_importance,
        'severity', v_severity,
        'confidence', 1.0,
        'fresh_until', v_fresh_until,
        'source', jsonb_build_object(
          'kind', 'system.workspace_event_stream',
          'identity', 'workspace_events',
          'latest_source_event_id', v_latest.id,
          'latest_source_event_type', v_latest.type
        ),
        'state', jsonb_build_object(
          'event_count', v_event_count,
          'failure_count', v_failure_count,
          'latest_event_occurred_at', v_latest.occurred_at
        ),
        'fingerprint', v_fingerprint
      ),
      'app'
    )
    returning id into v_observation_event_id;
  end if;

  insert into public.perception_source_state (
    workspace_id, source_kind, source_identity, subject_kind, subject_id,
    actor_kind, actor_id, last_observation_event_id, last_source_event_id,
    last_fingerprint, last_observed_at, fresh_until, confidence, status,
    consecutive_failures, last_failure_at, last_failure_code, retry_after, metadata
  ) values (
    p_workspace_id,
    'system.workspace_event_stream',
    'workspace_events',
    'workspace_event_stream',
    p_workspace_id::text,
    'system',
    null,
    v_observation_event_id,
    v_latest.id::text,
    v_fingerprint,
    p_observed_at,
    v_fresh_until,
    1.0,
    v_status,
    0,
    null,
    null,
    null,
    jsonb_build_object(
      'latest_source_event_type', v_latest.type,
      'latest_source_event_occurred_at', v_latest.occurred_at,
      'event_count', v_event_count,
      'failure_count', v_failure_count
    )
  )
  on conflict (workspace_id, source_kind, source_identity, subject_kind, subject_id)
  do update set
    last_observation_event_id = coalesce(excluded.last_observation_event_id, perception_source_state.last_observation_event_id),
    last_source_event_id = excluded.last_source_event_id,
    last_fingerprint = excluded.last_fingerprint,
    last_observed_at = excluded.last_observed_at,
    fresh_until = excluded.fresh_until,
    confidence = excluded.confidence,
    status = excluded.status,
    consecutive_failures = 0,
    last_failure_at = null,
    last_failure_code = null,
    retry_after = null,
    metadata = excluded.metadata,
    updated_at = now();

  insert into public.perception_capability_evidence (
    workspace_id, capability_key, source_kind, source_identity, status,
    autonomous_now, evidence_event_id, last_observed_at, fresh_until,
    confidence, notes, metadata
  ) values (
    p_workspace_id,
    'perception.continuous_awareness',
    'system.workspace_event_stream',
    'workspace_events',
    'active',
    true,
    coalesce(v_observation_event_id, (
      select last_observation_event_id
        from public.perception_source_state
       where workspace_id = p_workspace_id
         and source_kind = 'system.workspace_event_stream'
         and source_identity = 'workspace_events'
         and subject_kind = 'workspace_event_stream'
         and subject_id = p_workspace_id::text
    )),
    p_observed_at,
    v_fresh_until,
    1.0,
    'The canonical workspace event stream was observed directly in production and correlated with prior perception state.',
    jsonb_build_object(
      'observes', true,
      'normalizes', true,
      'correlates', true,
      'detects_change', true,
      'detects_anomaly', false,
      'acts_without_prompt', false,
      'authority_expanded', false,
      'source_event_retained', true,
      'interruption_budget_compatible', true
    )
  )
  on conflict (workspace_id, capability_key, source_kind, source_identity)
  do update set
    status = excluded.status,
    autonomous_now = excluded.autonomous_now,
    evidence_event_id = coalesce(excluded.evidence_event_id, perception_capability_evidence.evidence_event_id),
    last_observed_at = excluded.last_observed_at,
    fresh_until = excluded.fresh_until,
    confidence = excluded.confidence,
    notes = excluded.notes,
    metadata = excluded.metadata,
    updated_at = now();

  return jsonb_build_object(
    'status', 'accepted',
    'workspace_id', p_workspace_id,
    'source_kind', 'system.workspace_event_stream',
    'source_identity', 'workspace_events',
    'source_event_id', v_latest.id,
    'observation_event_id', v_observation_event_id,
    'change_kind', v_change_kind,
    'anomaly', v_anomaly,
    'fresh_until', v_fresh_until
  );
end;
$$;

revoke all on function public.observe_workspace_event_stream(uuid, timestamptz) from public;
grant execute on function public.observe_workspace_event_stream(uuid, timestamptz) to service_role;

comment on function public.observe_workspace_event_stream(uuid, timestamptz) is
'Observes the existing canonical workspace_events stream into perception_source_state and perception_capability_evidence. No action authority is granted.';
