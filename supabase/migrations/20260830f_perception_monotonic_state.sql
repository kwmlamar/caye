-- Perception current-state projections must not move backward when providers deliver
-- delayed/out-of-order events. Source history can arrive late; current state cannot.

create or replace function public.caye_guard_perception_source_state_monotonic()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.last_observed_at is not null
     and new.last_observed_at is not null
     and new.last_observed_at < old.last_observed_at then
    new.last_observation_event_id := old.last_observation_event_id;
    new.last_source_event_id := old.last_source_event_id;
    new.last_fingerprint := old.last_fingerprint;
    new.last_observed_at := old.last_observed_at;
    new.fresh_until := old.fresh_until;
    new.confidence := old.confidence;
    new.status := old.status;
    new.consecutive_failures := old.consecutive_failures;
    new.last_failure_at := old.last_failure_at;
    new.last_failure_code := old.last_failure_code;
    new.retry_after := old.retry_after;
    new.metadata := old.metadata;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_caye_perception_source_state_monotonic
  on public.perception_source_state;
create trigger trg_caye_perception_source_state_monotonic
  before update on public.perception_source_state
  for each row execute function public.caye_guard_perception_source_state_monotonic();

create or replace function public.caye_guard_perception_capability_evidence_monotonic()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.last_observed_at is not null
     and new.last_observed_at is not null
     and new.last_observed_at < old.last_observed_at then
    new.evidence_event_id := old.evidence_event_id;
    new.last_observed_at := old.last_observed_at;
    new.fresh_until := old.fresh_until;
    new.confidence := old.confidence;
    new.status := old.status;
    new.autonomous_now := old.autonomous_now;
    new.notes := old.notes;
    new.metadata := old.metadata;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_caye_perception_capability_evidence_monotonic
  on public.perception_capability_evidence;
create trigger trg_caye_perception_capability_evidence_monotonic
  before update on public.perception_capability_evidence
  for each row execute function public.caye_guard_perception_capability_evidence_monotonic();

revoke execute on function public.caye_guard_perception_source_state_monotonic() from public, anon, authenticated;
revoke execute on function public.caye_guard_perception_capability_evidence_monotonic() from public, anon, authenticated;
