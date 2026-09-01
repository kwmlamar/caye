-- Owner onboarding provenance and observability for continuous business learning.
-- This follows 20260901_continuous_business_learning.sql and deliberately adds
-- no parallel fact storage. Live onboarding and backfill both enter the same
-- business_learning_observations queue and canonical processor.

alter table public.business_learning_observations
  add column if not exists actor_type text,
  add column if not exists actor_id text,
  add column if not exists event_time timestamptz;

alter table public.business_learning_events
  add column if not exists actor_type text,
  add column if not exists actor_id text;

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

-- The base migration already has a workspace+source_fingerprint UNIQUE
-- constraint. This named partial index also makes the onboarding idempotency
-- contract explicit for schemas that predate that constraint.
create unique index if not exists idx_business_learning_observations_source_fingerprint
  on public.business_learning_observations (workspace_id, source_fingerprint)
  where source_fingerprint is not null;
