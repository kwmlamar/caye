-- Job-search standing authorization (founder autonomy).
--
-- Replaces the per-application / per-batch confirmation loop with a durable,
-- founder-granted operating policy. The policy IS the authorization: an
-- application that falls inside it needs no new confirmation.
--
-- Deliberately extends the EXISTING singleton rather than adding a parallel
-- policy table. job_search_execution_settings is already the row that
-- submission-gate.ts re-reads immediately before every click, so putting
-- standing authority here means the authority boundary that already exists
-- enforces it, and the emergency kill switch already outranks it. A second
-- table would be a second source of truth for "may Caye submit right now".
--
-- Additive only: every column has a default, so the existing seeded row stays
-- valid and standing authorization starts OFF and must be granted explicitly.
--
-- Rollback: drop the columns added below. No data migration, no backfill.

alter table public.job_search_execution_settings
  -- Grant / revocation lifecycle.
  add column if not exists standing_authorization_enabled boolean not null default false,
  add column if not exists standing_authorized_at timestamptz,
  add column if not exists standing_authorized_by text,
  -- The founder instruction that authorized this, kept as provenance so the
  -- grant can be audited against a real request rather than a model claim.
  add column if not exists standing_authorization_evidence jsonb not null default '{}'::jsonb,
  add column if not exists standing_revoked_at timestamptz,
  -- "Pause job applications" — reversible, distinct from revocation.
  add column if not exists standing_paused_at timestamptz,
  add column if not exists standing_paused_reason text,
  -- The policy envelope Caye may act inside without asking.
  add column if not exists standing_min_fit_score integer not null default 70,
  add column if not exists standing_max_applications_per_day integer not null default 150,
  add column if not exists standing_allowed_job_families text[] not null default '{}'::text[],
  add column if not exists standing_allowed_providers text[] not null default array['greenhouse']::text[],
  add column if not exists standing_excluded_employers text[] not null default '{}'::text[],
  -- One ambiguous submission stops autonomous submitting until reconciled.
  add column if not exists standing_pause_on_submission_uncertain boolean not null default true,
  -- Consequential answers may only come from verified canonical founder facts.
  add column if not exists standing_use_verified_facts_only boolean not null default true;

-- A score threshold outside 0..100 is not a threshold, and a standing daily
-- ceiling above the hard rollout ceiling would quietly reintroduce the limit
-- the other controls depend on. Mirrors MAX_DAILY_SUBMISSION_CAP in
-- lib/job-search/execution/rollout.ts.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'job_search_standing_min_fit_score_range') then
    alter table public.job_search_execution_settings
      add constraint job_search_standing_min_fit_score_range
      check (standing_min_fit_score >= 0 and standing_min_fit_score <= 100);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'job_search_standing_daily_cap_range') then
    alter table public.job_search_execution_settings
      add constraint job_search_standing_daily_cap_range
      check (standing_max_applications_per_day >= 0 and standing_max_applications_per_day <= 150);
  end if;

  -- Verified-facts-only is not a runtime toggle. Allowing it to be switched
  -- off would let autonomous submissions answer citizenship, work
  -- authorization, or clearance questions from inference, which is the one
  -- thing standing authorization must never buy.
  if not exists (select 1 from pg_constraint where conname = 'job_search_standing_verified_facts_only') then
    alter table public.job_search_execution_settings
      add constraint job_search_standing_verified_facts_only
      check (standing_use_verified_facts_only = true);
  end if;
end $$;

comment on column public.job_search_execution_settings.standing_authorization_enabled is
  'Founder standing authorization for autonomous APPLY/SKIP/ESCALATE. The policy itself is the authorization; an in-policy application requires no per-action confirmation. Never set from model output — only through a founder-scoped tool that records evidence.';
