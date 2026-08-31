-- Founder job-search operator — production Greenhouse live submission.
--
-- Three things change here, all of them additive:
--
--   1. The daily-submission cap ceiling moves from 3 to 150. The <=3 CHECK
--      (20260830a) was correct for experimental rollout, but the production
--      operator's policy ceiling is 150/day. The safety system is GENERALIZED,
--      not deleted: the cap is still an explicit, auditable, founder-set
--      number enforced atomically in reserve_job_search_submission_slot, and
--      the DB still refuses anything above the hard maximum. Raising the
--      ceiling does not raise the cap — the live value stays whatever the
--      founder last set, and the rollout stages (1 -> 5 -> 25 -> 75 -> 150)
--      are advanced one deliberate confirmation at a time.
--
--   2. job_search_execution_attempts gains the consequential-action evidence
--      columns. A real submission must be auditable end to end: which exact
--      destination was clicked, under which claim and reservation, at what
--      instant before and after the click, what URL resulted, and how the
--      confirmation was classified. Without these, "did we actually apply?"
--      is unanswerable after the fact.
--
--   3. job_search_batch_authorizations (new) — a founder-granted, bounded,
--      expiring authorization for autonomous batch submission, with an atomic
--      consume RPC so N concurrent workers can never exceed the authorized
--      count. This is what makes "apply to up to 5 qualified jobs" safe to
--      grant once instead of confirming every single application.
--
-- Reversible: restore the <=3 CHECK, drop the added attempt columns, drop
-- job_search_batch_authorizations and its RPC.

-- ---------------------------------------------------------------------------
-- 1. Generalize the daily cap ceiling to the production policy maximum.
-- ---------------------------------------------------------------------------
alter table public.job_search_execution_settings
  drop constraint if exists job_search_execution_settings_daily_submission_cap_check;
alter table public.job_search_execution_settings
  add constraint job_search_execution_settings_daily_submission_cap_check
  check (daily_submission_cap >= 0 and daily_submission_cap <= 150);

comment on column public.job_search_execution_settings.daily_submission_cap is
  'Real ATS submissions permitted per UTC day. Hard system maximum 150 (CHECK constraint above, mirrored by MAX_DAILY_SUBMISSION_CAP in lib/job-search/execution/rollout.ts). Enforced atomically by reserve_job_search_submission_slot, never by a read-then-count in application code. Advanced through deliberate rollout stages (1, 5, 25, 75, 150) — never set straight to the ceiling.';

-- ---------------------------------------------------------------------------
-- 2. Consequential-action evidence on every execution attempt.
-- ---------------------------------------------------------------------------
alter table public.job_search_execution_attempts
  add column if not exists destination_url text,
  add column if not exists claim_token uuid,
  add column if not exists submission_reservation_id uuid,
  add column if not exists submit_clicked_at timestamptz,
  add column if not exists submit_observed_at timestamptz,
  add column if not exists result_url text,
  add column if not exists confirmation_method text,
  add column if not exists confirmation_signals jsonb,
  add column if not exists resume_artifact_sha256 text,
  add column if not exists answer_set_sha256 text,
  add column if not exists batch_authorization_id uuid;

comment on column public.job_search_execution_attempts.submit_clicked_at is
  'Set immediately BEFORE the single consequential submit click. Its presence is the marker that an application may have reached the employer: any failure after this timestamp exists must resolve to SUBMISSION_UNCERTAIN, never to a retryable failure.';
comment on column public.job_search_execution_attempts.confirmation_signals is
  'The provider-specific positive signals observed AFTER the click (route change, confirmation DOM, form disappearance). Generic "thank you" text alone is never sufficient — see providers/greenhouse-confirmation.ts.';
comment on column public.job_search_execution_attempts.answer_set_sha256 is
  'Hash binding this attempt to the exact answer set that was filled. Lets an auditor prove which answers were sent without storing the answer values themselves.';

-- ---------------------------------------------------------------------------
-- 3. Bounded, expiring founder authorization for autonomous batches.
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_batch_authorizations (
  id uuid primary key default gen_random_uuid(),
  created_by text not null,
  provider text not null check (provider in ('greenhouse', 'lever', 'ashby', 'workday', 'generic')),
  max_applications integer not null check (max_applications > 0 and max_applications <= 150),
  min_score integer not null default 0 check (min_score >= 0 and min_score <= 100),
  allowed_job_families text[] not null default '{}',
  consumed_count integer not null default 0 check (consumed_count >= 0),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists job_search_batch_authorizations_active_idx
  on public.job_search_batch_authorizations (expires_at) where revoked_at is null;

alter table public.job_search_batch_authorizations enable row level security;

comment on table public.job_search_batch_authorizations is
  'A founder-granted, bounded, expiring authorization for autonomous batch submission ("apply to up to 5 qualified Greenhouse jobs"). Service-role-only: RLS is enabled with zero policies, the intended deny-by-default state for founder-operator tables. consumed_count is only ever advanced through consume_job_search_batch_slot so concurrent workers cannot exceed max_applications.';

-- Atomic consume. Mirrors reserve_job_search_submission_slot's shape: the
-- check and the increment are one statement under a row lock, so N concurrent
-- workers cannot collectively exceed max_applications.
create or replace function public.consume_job_search_batch_slot(p_authorization_id uuid, p_provider text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_updated integer;
begin
  update public.job_search_batch_authorizations
     set consumed_count = consumed_count + 1
   where id = p_authorization_id
     and revoked_at is null
     and expires_at > now()
     and provider = p_provider
     and consumed_count < max_applications;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.consume_job_search_batch_slot(uuid, text) from public, anon, authenticated;
grant execute on function public.consume_job_search_batch_slot(uuid, text) to service_role;
