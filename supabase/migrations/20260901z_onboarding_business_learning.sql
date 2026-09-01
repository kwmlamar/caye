-- Owner onboarding is a first-class business-learning source. This migration
-- extends the canonical observation/event substrate without creating a second
-- fact writer or onboarding-specific memory table.

alter table public.business_learning_observations
  add column if not exists actor_type text,
  add column if not exists actor_id text,
  add column if not exists event_time timestamptz;

update public.business_learning_observations
set event_time = coalesce(event_time, created_at)
where event_time is null;

create index if not exists business_learning_observations_event_time_idx
  on public.business_learning_observations(workspace_id, event_time desc);

alter table public.business_learning_events
  drop constraint if exists business_learning_events_event_type_check;

alter table public.business_learning_events
  add constraint business_learning_events_event_type_check check (event_type in (
    'observation_examined','observation_excluded','extraction_started','extraction_failed',
    'candidate_created','candidate_deduplicated','candidate_rejected','fact_promoted',
    'fact_updated','conflict_detected','conflict_resolved','fact_superseded',
    'onboarding_learning_submitted','onboarding_learning_extraction_started',
    'onboarding_learning_fact_created','onboarding_learning_candidate_created',
    'onboarding_learning_deduplicated','onboarding_learning_conflict_resolved',
    'onboarding_learning_skipped','onboarding_learning_failed'
  ));

-- Idempotent event mirror guard. NULLS NOT DISTINCT makes candidate/fact-less
-- submission/failure events deduplicate as well as per-candidate aliases.
create unique index if not exists business_learning_events_onboarding_dedupe_uidx
  on public.business_learning_events(
    workspace_id, observation_id, event_type, candidate_id, fact_id, source_kind, source_id
  ) nulls not distinct
  where event_type like 'onboarding_learning_%';
