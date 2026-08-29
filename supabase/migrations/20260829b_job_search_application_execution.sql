-- Job-search operator — real ATS application-submission execution
-- (2026-08-29, CAY-194 / GitHub #194, follow-up to CAY-192 / #196).
--
-- WHY
-- #196 shipped SOURCE -> SCORE -> PREPARE -> NEEDS_HUMAN. Every application
-- landed at NEEDS_HUMAN; there was no code path to SUBMITTED at all (see
-- lib/job-search/application-executor.ts's doc comment as it existed before
-- this PR). This migration adds the smallest schema needed to safely support
-- PREPARE -> APPLYING -> SUBMITTED | NEEDS_HUMAN | FAILED | SUBMISSION_UNCERTAIN
-- for one ATS provider (Greenhouse, via its documented Job Board API — see
-- lib/job-search/execution/providers/greenhouse.ts for why), behind a
-- default-OFF rollout switch.
--
-- WHAT THIS ADDS
--   1. job_search_applications gains an execution claim/lease (mirrors
--      business_artifacts' processing_claim_token/processing_claimed_at
--      exactly — lib/artifacts/process.ts), an attempt counter, a dry_run
--      flag, and a new terminal status SUBMISSION_UNCERTAIN for "the submit
--      action may have happened but confirmation is unavailable — never
--      auto-retry."
--   2. job_search_application_answers gains ATS form-field metadata columns
--      (provider_field_id, input_type, required, allowed_options,
--      confidence, auto_fill_permitted) and a `reusable` flag, plus a new
--      answer_source value 'application_specific' — Lamar's answer to a
--      one-off question that he did NOT ask to be remembered as a canonical
--      profile fact. This is additive to the existing table rather than a
--      new one: an ATS-discovered field IS the same concept as an
--      application answer, just with more provenance/shape metadata now
--      that automation actually fills it in.
--   3. job_search_execution_attempts (new, append-only) — one row per
--      execution attempt, the audit trail the issue requires (preflight
--      result, domain validations, fields discovered, blockers, submission
--      response, confirmation evidence, resume artifact used). Deliberately
--      NOT folded into job_search_events: that table is a single untyped
--      payload log for every phase of the whole pipeline; this one has a
--      fixed, queryable shape specific to one execution attempt so "show me
--      submission evidence for this application" is a normal indexed query,
--      not a payload-jsonb scan.
--   4. job_search_execution_settings (new, singleton, same shape as
--      job_search_settings) — the rollout controls: automation_enabled,
--      dry_run, daily_submission_cap, allowlisted_providers,
--      allowlisted_employer_domains, emergency_paused. Seeded fully
--      disabled — real submission requires the founder to explicitly flip
--      automation_enabled AND dry_run=false, both through gated,
--      confirmation-required Admin Shell tools (see PR description).
--
-- No new SECURITY DEFINER RPC is added by this migration. Every write here
-- goes through createServiceClient() from a founder-gated Admin Shell tool
-- or cron route, exactly like job_search_settings already does — there is
-- no new client-callable RPC surface for a privilege-escalation bug to hide
-- in. (The #196 audit's SECURITY DEFINER fix pattern — safe search_path,
-- revoke PUBLIC/anon/authenticated, grant service_role only, behavioral
-- SET ROLE tests — remains the required pattern for any *future* PR that
-- does add one.)
--
-- Reversible: drop job_search_execution_attempts and
-- job_search_execution_settings; revert the ALTERs on job_search_applications
-- and job_search_application_answers (drop the added columns, restore the
-- original CHECK constraints).

-- ---------------------------------------------------------------------------
-- job_search_profiles — contact fields required by real ATS submission
-- forms (email/phone) that #196's schema had no reason to carry yet.
-- ---------------------------------------------------------------------------
alter table public.job_search_profiles
  add column if not exists contact_email text,
  add column if not exists contact_phone text;

comment on column public.job_search_profiles.contact_email is
  'Required by every real ATS application form (Greenhouse included). Null until the founder verifies their profile with real contact details — preflight''s founder_profile_verified check (status=''verified'') is the gate that keeps an execution attempt from ever reading the seed NEEDS_VERIFICATION placeholder here.';

-- ---------------------------------------------------------------------------
-- job_search_applications — execution claim/lease + SUBMISSION_UNCERTAIN
-- ---------------------------------------------------------------------------
alter table public.job_search_applications
  drop constraint if exists job_search_applications_status_check;
alter table public.job_search_applications
  add constraint job_search_applications_status_check
  check (status in (
    'PREPARED', 'APPLYING', 'NEEDS_HUMAN', 'SUBMITTED', 'SUBMISSION_UNCERTAIN',
    'FAILED', 'FOLLOWUP_DUE', 'INTERVIEW', 'REJECTED', 'OFFER'
  ));

alter table public.job_search_applications
  add column if not exists execution_claim_token uuid,
  add column if not exists execution_claimed_at timestamptz,
  add column if not exists execution_attempt_count integer not null default 0,
  add column if not exists dry_run boolean not null default true;

comment on column public.job_search_applications.execution_claim_token is
  'Compare-and-set execution lease, mirrors business_artifacts.processing_claim_token (lib/artifacts/process.ts). Only the caller whose atomic UPDATE ... WHERE status = ''PREPARED'' actually moved the row to APPLYING holds this token; only that same token may release the claim.';
comment on column public.job_search_applications.execution_claimed_at is
  'Lease start time. A claim older than the executor''s LEASE_MS with no recorded outcome is treated as a crashed worker — see lib/job-search/execution/claim.ts. Unlike the artifacts lease (which resets back to a retryable state), a stale application-execution claim resolves to NEEDS_HUMAN, never back to PREPARED: a crash mid-APPLYING might have already reached the ATS submit step, so this must never be silently auto-retried.';

create index if not exists job_search_applications_stale_claim_idx
  on public.job_search_applications (execution_claimed_at)
  where status = 'APPLYING';

create index if not exists job_search_applications_submitted_idx
  on public.job_search_applications (submitted_at)
  where status = 'SUBMITTED';

-- ---------------------------------------------------------------------------
-- job_search_application_answers — ATS field metadata + application-specific
-- (non-reusable) answers
-- ---------------------------------------------------------------------------
alter table public.job_search_application_answers
  drop constraint if exists job_search_application_answers_answer_source_check;
alter table public.job_search_application_answers
  add constraint job_search_application_answers_answer_source_check
  check (answer_source in ('profile_fact', 'generated_safe', 'needs_human', 'application_specific'));

alter table public.job_search_application_answers
  add column if not exists provider_field_id text,
  add column if not exists input_type text,
  add column if not exists required boolean not null default false,
  add column if not exists allowed_options jsonb,
  add column if not exists confidence numeric,
  add column if not exists auto_fill_permitted boolean not null default false,
  add column if not exists reusable boolean not null default false;

comment on column public.job_search_application_answers.reusable is
  'True only when the founder explicitly said this answer should be remembered — in which case it is ALSO written to job_search_profile_facts via job_search_write_profile_fact() and this row''s answer_source becomes profile_fact. False (the default) keeps an answer scoped to exactly this one application, never silently promoted into a canonical fact other applications would auto-fill from.';
comment on column public.job_search_application_answers.auto_fill_permitted is
  'Deterministic gate, not an LLM opinion: true only when resolveAnswer (lib/job-search/execution/preflight.ts) found a verified profile_fact for this exact field. An LLM may assist parsing the ATS form, but it never sets this column — see the module doc comment for why.';

-- ---------------------------------------------------------------------------
-- job_search_execution_attempts (append-only audit trail per attempt)
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_execution_attempts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.job_search_applications (id) on delete cascade,
  attempt_number integer not null,
  provider text not null check (provider in ('greenhouse', 'lever', 'ashby', 'workday', 'generic')),
  dry_run boolean not null,
  outcome text not null check (outcome in (
    'submitted', 'needs_human', 'submission_uncertain', 'failed', 'preflight_blocked'
  )),
  -- Structured pass/fail per deterministic preflight check (see
  -- preflight.ts's PREFLIGHT_CHECKS) — never raw sensitive answer values.
  preflight jsonb not null default '{}'::jsonb,
  -- [{ url, hostname, allowed, reason }] for every outbound destination
  -- validated during this attempt (initial apply URL + every redirect hop).
  domain_validations jsonb not null default '[]'::jsonb,
  fields_discovered_count integer not null default 0,
  -- [{ category, label, reason }] human-review blockers found this attempt.
  blockers jsonb not null default '[]'::jsonb,
  -- Redacted provider response: status code + whatever non-sensitive
  -- identifiers it returned. Never the raw request body (which would
  -- contain form answers) and never full response headers/cookies.
  submission_response jsonb,
  -- Positive evidence only — see providers/greenhouse.ts. Null unless the
  -- provider returned a verifiable confirmation identifier.
  confirmation_evidence jsonb,
  resume_artifact_id uuid references public.job_search_generated_artifacts (id) on delete set null,
  failure_reason text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (application_id, attempt_number)
);

comment on table public.job_search_execution_attempts is
  'Append-only. One row per execution attempt (preflight -> claim -> provider submit). Never updated after completed_at is set — a retry is a NEW row with attempt_number + 1, never a mutation of a prior attempt''s evidence.';

create index if not exists job_search_execution_attempts_application_idx
  on public.job_search_execution_attempts (application_id, attempt_number desc);

alter table public.job_search_execution_attempts enable row level security;

-- ---------------------------------------------------------------------------
-- job_search_execution_settings (singleton rollout controls)
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_execution_settings (
  id boolean primary key default true check (id),
  automation_enabled boolean not null default false,
  dry_run boolean not null default true,
  -- Upper bound enforced in the schema, not only in rollout.ts's
  -- setDailySubmissionCap: a safety cap that any writer can set to an
  -- arbitrary number is not a safety cap. Raising this ceiling is a
  -- deliberate migration, never a runtime setting.
  daily_submission_cap integer not null default 3 check (daily_submission_cap >= 0 and daily_submission_cap <= 10),
  allowlisted_providers jsonb not null default '["greenhouse"]'::jsonb,
  allowlisted_employer_domains jsonb not null default '[]'::jsonb,
  emergency_paused boolean not null default false,
  updated_at timestamptz not null default now()
);

comment on table public.job_search_execution_settings is
  'Singleton (id is always true). Rollout gate for real ATS submission, independent of job_search_settings.paused (which only gates PREPARATION). Seeded fully OFF: automation_enabled=false, dry_run=true, daily_submission_cap=3. A real submission requires automation_enabled=true AND dry_run=false AND emergency_paused=false, each flipped only through a gated, confirmation-required Admin Shell tool — see lib/job-search/execution/rollout.ts.';

alter table public.job_search_execution_settings enable row level security;

insert into public.job_search_execution_settings (id)
values (true)
on conflict (id) do nothing;
