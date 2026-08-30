-- CAY-216 audit: the rollout contract is at most three real submissions per
-- UTC day.  The earlier execution migration allowed 10, which made the
-- database safety boundary weaker than the stated rollout policy.
alter table public.job_search_execution_settings
  drop constraint if exists job_search_execution_settings_daily_submission_cap_check;
alter table public.job_search_execution_settings
  add constraint job_search_execution_settings_daily_submission_cap_check
  check (daily_submission_cap >= 0 and daily_submission_cap <= 3);

-- Existing settings must comply before the constraint can be added. This
-- migration is intentionally fail-closed rather than silently lowering a
-- value that a founder may believe is still in force.
