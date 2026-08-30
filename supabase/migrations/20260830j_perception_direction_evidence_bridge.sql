-- Bridge demonstrated perception runtime behavior into the canonical founder Direction
-- capability evidence substrate introduced by the Operating Intelligence roadmap.
--
-- Domain-specific perception evidence remains the detailed source of truth. This trigger
-- publishes only real, autonomous, observed behavior into Direction. It never changes
-- maturity_status or progress_percent.

create or replace function public.publish_perception_direction_evidence()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_capability_id uuid;
  v_observed_at timestamptz;
begin
  if new.capability_key <> 'perception.continuous_awareness'
     or new.autonomous_now is not true
     or new.status <> 'active'
     or new.evidence_event_id is null
     or new.last_observed_at is null then
    return new;
  end if;

  select id
    into v_capability_id
    from public.caye_operating_intelligence_capabilities
   where capability_key = 'perception_awareness';

  -- Fail closed rather than silently treating a missing canonical roadmap sink as success.
  if v_capability_id is null then
    raise exception 'canonical Perception & Continuous Awareness capability is missing';
  end if;

  v_observed_at := new.last_observed_at;

  insert into public.caye_operating_intelligence_capability_evidence (
    capability_id,
    evidence_kind,
    source_ref,
    summary,
    verifies_capability,
    confidence,
    observed_at,
    verified_at
  ) values (
    v_capability_id,
    'runtime',
    'perception_capability_evidence:' || new.id::text,
    coalesce(new.notes, 'Authorized perception source produced autonomous observed runtime evidence.'),
    true,
    new.confidence,
    v_observed_at,
    v_observed_at
  )
  on conflict (capability_id, evidence_kind, source_ref)
  do update set
    summary = excluded.summary,
    verifies_capability = true,
    confidence = excluded.confidence,
    observed_at = excluded.observed_at,
    verified_at = excluded.verified_at;

  return new;
end;
$$;

drop trigger if exists trg_publish_perception_direction_evidence
  on public.perception_capability_evidence;
create trigger trg_publish_perception_direction_evidence
after insert or update of status, autonomous_now, evidence_event_id, last_observed_at, confidence, notes
on public.perception_capability_evidence
for each row
execute function public.publish_perception_direction_evidence();

revoke execute on function public.publish_perception_direction_evidence()
  from public, anon, authenticated;
grant execute on function public.publish_perception_direction_evidence()
  to service_role;

comment on function public.publish_perception_direction_evidence() is
  'Publishes only active autonomous observed perception behavior into canonical Direction evidence; never mutates maturity or numeric progress.';
