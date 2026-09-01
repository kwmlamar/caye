-- Extend the existing job-search application/followup model for recruiter responses.
-- This deliberately does not create a second CRM or state machine.

alter table public.job_search_applications
  add column if not exists first_response_at timestamptz,
  add column if not exists last_response_at timestamptz,
  add column if not exists rejected_at timestamptz,
  add column if not exists offer_at timestamptz,
  add column if not exists priority_score integer not null default 0;

alter table public.job_search_followups
  add column if not exists direction text not null default 'INBOUND',
  add column if not exists response_classification text,
  add column if not exists subject text,
  add column if not exists body text;

alter table public.job_search_followups
  drop constraint if exists job_search_followups_direction_check;
alter table public.job_search_followups
  add constraint job_search_followups_direction_check
  check (direction in ('INBOUND', 'OUTBOUND'));

alter table public.job_search_followups
  drop constraint if exists job_search_followups_response_classification_check;
alter table public.job_search_followups
  add constraint job_search_followups_response_classification_check
  check (response_classification is null or response_classification in (
    'rejection', 'recruiter_interest', 'screen_request', 'interview_request',
    'assessment', 'additional_information', 'scheduling', 'offer', 'unknown'
  ));

alter table public.job_search_followups
  drop constraint if exists job_search_followups_followup_type_check;
alter table public.job_search_followups
  add constraint job_search_followups_followup_type_check
  check (followup_type in (
    'confirmation_check', 'recruiter_reply', 'scheduled_followup', 'interview_request',
    'human_response', 'rejection', 'recruiter_interest', 'screen_request',
    'assessment', 'additional_information', 'scheduling', 'offer', 'unknown',
    'follow_up_nudge'
  ));

create index if not exists idx_job_search_applications_response_priority
  on public.job_search_applications (priority_score desc, last_response_at desc)
  where last_response_at is not null;

create index if not exists idx_job_search_followups_application_direction_created
  on public.job_search_followups (application_id, direction, created_at desc);

-- Existing RLS enablement, policies, grants, and the canonical
-- job_search_applications.status constraint are intentionally untouched.
