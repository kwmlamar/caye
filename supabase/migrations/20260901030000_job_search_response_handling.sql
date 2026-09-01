-- Job-search response-handling loop: turn inbound recruiter/ATS email into
-- funnel state, priority, and evidence for outbound replies and interview
-- scheduling.
--
-- Deliberately extends the EXISTING job_search_applications.status enum and
-- job_search_followups.followup_type enum rather than introducing a second,
-- parallel state machine — see lib/job-search/response-classification.ts for
-- the classifier and lib/job-search/email-correlation.ts for where the new
-- values get written.

-- ---------------------------------------------------------------------------
-- job_search_applications — response-tracking columns
-- ---------------------------------------------------------------------------
alter table public.job_search_applications
  add column if not exists priority text not null default 'normal' check (priority in ('normal', 'high')),
  add column if not exists first_response_at timestamptz,
  add column if not exists last_response_at timestamptz,
  add column if not exists rejected_at timestamptz,
  add column if not exists offer_at timestamptz,
  add column if not exists ghosted_at timestamptz;

-- Fast "what needs my attention" read: high-priority, not yet terminal.
create index if not exists job_search_applications_priority_idx
  on public.job_search_applications (priority)
  where priority = 'high' and status not in ('REJECTED', 'OFFER');

create index if not exists job_search_applications_ghosted_idx
  on public.job_search_applications (ghosted_at)
  where ghosted_at is not null;

-- ---------------------------------------------------------------------------
-- job_search_followups — response classification + outbound reply evidence
-- ---------------------------------------------------------------------------
alter table public.job_search_followups
  drop constraint if exists job_search_followups_followup_type_check;

alter table public.job_search_followups
  add constraint job_search_followups_followup_type_check check (followup_type in (
    -- pre-existing
    'confirmation_check', 'recruiter_reply', 'scheduled_followup', 'interview_request',
    -- canonical response-classification states (mission spec)
    'rejection', 'recruiter_interest', 'screen_request', 'assessment',
    'additional_information', 'scheduling', 'offer', 'unknown'
  ));

alter table public.job_search_followups
  add column if not exists direction text not null default 'inbound' check (direction in ('inbound', 'outbound')),
  add column if not exists channel text not null default 'email' check (channel in ('email')),
  add column if not exists sent_at timestamptz,
  -- Full outbound body, kept separate from `note` (which stays a short
  -- inbound evidence snippet — "from: subject") so a sent reply has real
  -- execution evidence, matching the job_search_execution_attempts pattern
  -- used for application submission.
  add column if not exists body text;

create index if not exists job_search_followups_direction_idx
  on public.job_search_followups (application_id, direction, created_at desc);
