-- Job-search operator v1 (2026-08-28, CAY-192 / GitHub #192)
--
-- WHY
-- A private, founder-only capability: source, score, tailor, track, and
-- (only where actually safe) submit job applications for Lamar's own OPT
-- job search. This is explicitly NOT customer-facing Caye behavior — no
-- table here has a workspace_id, mirroring the existing founder-only,
-- workspace-less pattern already used by caye_admin_shell_messages
-- (20260721d): "RLS enabled, zero policies" is the deliberate deny-by-
-- default posture — every table here is reached only through
-- createServiceClient() after an isFounderUserId()-equivalent check in the
-- calling tool/route, never through anon/authenticated Supabase clients.
--
-- WHAT THIS ADDS (10 tables, matching the issue's conceptual list with two
-- additions: job_search_settings for the pause switch, and job_search_events
-- as the single append-only audit log covering every phase):
--
--   job_search_profiles         - singleton founder profile (education,
--                                  skills, links, work-auth, location prefs).
--   job_search_profile_facts    - canonical Q&A answers with provenance,
--                                  same append-only supersession shape as
--                                  business_facts (20260818/20260826), one
--                                  active row per canonical_key, written
--                                  through job_search_write_profile_fact()
--                                  (row-lock chaining, mirrors
--                                  write_business_fact_atomic exactly).
--   job_search_sources          - adapter registry/config (Greenhouse,
--                                  Lever, etc).
--   job_search_candidates       - normalized/deduped/scored roles. One row
--                                  per real-world posting; discovered_via
--                                  jsonb array records every source hit that
--                                  matched the same canonical_key, so
--                                  cross-source dedup keeps a full audit
--                                  trail without a separate join table.
--   job_search_resume_variants  - >=3 truthful base resumes.
--   job_search_applications     - one row per candidate that reached QUEUED;
--                                  the PREPARED -> APPLYING -> NEEDS_HUMAN |
--                                  SUBMITTED | FAILED -> FOLLOWUP_DUE state
--                                  machine lives here.
--   job_search_application_answers - screener answers used per application,
--                                  each traceable to a profile fact or
--                                  flagged needs_human.
--   job_search_generated_artifacts - generated resume/cover-letter text,
--                                  traceable to the source facts used.
--   job_search_followups        - follow-up tracking / recruiter reply
--                                  correlation (Gmail correlation deferred,
--                                  see follow-up issue referenced in the PR).
--   job_search_runs             - one row per sourcing/scoring/apply/
--                                  followup pipeline run (stats, errors).
--   job_search_settings         - singleton: paused flag + daily cap.
--   job_search_events           - append-only audit log for every sourced
--                                  role, score, generated artifact, answer,
--                                  submit action, failure, and escalation.
--
-- Reversible: drop all tables/functions below (bottom-up, application_answers
-- and generated_artifacts before applications, applications before
-- candidates, profile_facts function before profile_facts table).

-- ---------------------------------------------------------------------------
-- job_search_profiles
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_profiles (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'needs_verification' check (status in ('needs_verification', 'verified')),
  full_name text,
  headline text,
  summary text,
  education jsonb not null default '[]'::jsonb,
  skills jsonb not null default '[]'::jsonb,
  experience jsonb not null default '[]'::jsonb,
  links jsonb not null default '{}'::jsonb,
  work_authorization jsonb not null default '{}'::jsonb,
  location_preferences jsonb not null default '{}'::jsonb,
  target_titles jsonb not null default '[]'::jsonb,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.job_search_profiles is
  'Founder-only. Singleton-by-convention (one active row) verified job-search profile. Seeded with a NEEDS_VERIFICATION placeholder row by this migration — Lamar must populate real verified facts before this pipeline is used for real applications. No workspace_id: this must never be reachable from customer-workspace context.';

alter table public.job_search_profiles enable row level security;

-- ---------------------------------------------------------------------------
-- job_search_profile_facts (canonical answers, business_facts-shaped)
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_profile_facts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.job_search_profiles (id) on delete cascade,
  canonical_key text not null,
  category text not null check (category in (
    'work_authorization', 'citizenship', 'clearance', 'relocation',
    'compensation', 'demographic', 'disability', 'veteran',
    'criminal_history', 'attestation', 'general'
  )),
  question text not null,
  answer text not null,
  -- High-risk categories require an explicit human-provenance source; never
  -- 'inferred' for these (enforced in application code, see policy-gate.ts).
  source text not null check (source in ('founder-direct', 'resume-derived', 'inferred')),
  created_by text,
  last_verified_at timestamptz not null default now(),
  superseded_by uuid references public.job_search_profile_facts (id) on delete set null,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.job_search_profile_facts is
  'Append-only canonical Q&A answers with provenance, mirroring business_facts supersession (20260818/20260826). Never mutated in place — corrections insert a new row and mark the old one superseded.';

create unique index if not exists job_search_profile_facts_active_canonical_key_idx
  on public.job_search_profile_facts (profile_id, canonical_key)
  where superseded_at is null;

create index if not exists job_search_profile_facts_profile_idx
  on public.job_search_profile_facts (profile_id)
  where superseded_at is null;

alter table public.job_search_profile_facts enable row level security;

-- Row-lock-chained atomic write, mirrors write_business_fact_atomic exactly
-- (20260826_business_facts_scope_and_canonical_key.sql) so two concurrent
-- correction writes for the same canonical_key serialize into a clean
-- supersession chain instead of leaving two active rows.
create or replace function public.job_search_write_profile_fact(
  p_profile_id uuid,
  p_canonical_key text,
  p_category text,
  p_question text,
  p_answer text,
  p_source text,
  p_created_by text default null
) returns table (id uuid, created_at timestamptz, superseded_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chain_target_id uuid;
  v_new_id uuid;
  v_new_created_at timestamptz;
begin
  select f.id into v_chain_target_id
  from public.job_search_profile_facts f
  where f.profile_id = p_profile_id
    and f.canonical_key = p_canonical_key
    and f.superseded_at is null
  for update;

  -- ORDER MATTERS (mirrors write_business_fact_atomic,
  -- 20260826_business_facts_scope_and_canonical_key.sql): the unique
  -- index job_search_profile_facts_active_canonical_key_idx is a partial
  -- unique index on (profile_id, canonical_key) WHERE superseded_at IS
  -- NULL, checked immediately (non-deferrable) on insert. Superseding the
  -- old row FIRST frees it from the index before the new row is
  -- inserted; inserting first would momentarily leave two active rows
  -- for the same key and fail the unique check.
  if v_chain_target_id is not null then
    update public.job_search_profile_facts
    set superseded_at = now()
    where job_search_profile_facts.id = v_chain_target_id;
  end if;

  insert into public.job_search_profile_facts (
    profile_id, canonical_key, category, question, answer, source, created_by
  ) values (
    p_profile_id, p_canonical_key, p_category, p_question, p_answer, p_source, p_created_by
  )
  returning job_search_profile_facts.id, job_search_profile_facts.created_at
  into v_new_id, v_new_created_at;

  if v_chain_target_id is not null then
    update public.job_search_profile_facts
    set superseded_by = v_new_id
    where job_search_profile_facts.id = v_chain_target_id;
  end if;

  return query select v_new_id, v_new_created_at, v_chain_target_id;
end;
$$;

comment on function public.job_search_write_profile_fact is
  'Atomic canonical-key-chained write for job_search_profile_facts. Row-locks the current active row for (profile_id, canonical_key) inside one transaction before inserting the replacement, so concurrent corrections chain safely rather than leaving two active rows.';

-- SECURITY: this is a SECURITY DEFINER function, so it runs with the
-- privileges (and RLS exemption) of its owner regardless of caller. Postgres
-- grants EXECUTE on new functions to PUBLIC by default; without these
-- revokes, any anon/authenticated Supabase client could call this RPC
-- directly and write into job_search_profile_facts despite RLS having zero
-- policies on the table — exactly the founder-only invariant this migration
-- exists to enforce. Mirrors write_business_fact_atomic's revoke/grant block
-- (20260826_business_facts_scope_and_canonical_key.sql).
revoke all on function public.job_search_write_profile_fact(uuid, text, text, text, text, text, text) from public;
revoke all on function public.job_search_write_profile_fact(uuid, text, text, text, text, text, text) from anon;
revoke all on function public.job_search_write_profile_fact(uuid, text, text, text, text, text, text) from authenticated;
grant execute on function public.job_search_write_profile_fact(uuid, text, text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- job_search_sources
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  adapter_type text not null check (adapter_type in ('greenhouse', 'lever', 'ashby', 'workday', 'manual')),
  display_name text not null,
  enabled boolean not null default true,
  -- Never a LinkedIn/Indeed adapter key — enforced in application code
  -- (lib/job-search/sources/index.ts) as well as documented here: this
  -- table is discovery-source config only, never an apply-automation config.
  config jsonb not null default '{}'::jsonb,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.job_search_sources enable row level security;

-- ---------------------------------------------------------------------------
-- job_search_candidates (normalized, deduped, scored roles)
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_candidates (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  company text not null,
  title text not null,
  requisition_id text,
  location text,
  remote_type text check (remote_type in ('remote', 'hybrid', 'on_site', 'unknown')),
  employment_type text,
  salary jsonb,
  description text,
  requirements text,
  posted_at timestamptz,
  discovered_at timestamptz not null default now(),
  source_url text not null,
  apply_url text not null,
  -- Every source that produced a hit matching this canonical_key, each with
  -- its own source_id/source_url/discovered_at — the audit trail for
  -- cross-source dedup (regression test: "duplicate cross-source posting ->
  -- one canonical candidate").
  discovered_via jsonb not null default '[]'::jsonb,
  work_auth_signals jsonb not null default '{}'::jsonb,
  citizenship_required boolean not null default false,
  clearance_required boolean not null default false,
  opt_excluded boolean not null default false,
  min_years_experience_required integer,
  skills jsonb not null default '[]'::jsonb,
  fit_score integer check (fit_score >= 0 and fit_score <= 100),
  score_explanation jsonb,
  hard_block_reason text,
  rejection_reasons jsonb not null default '[]'::jsonb,
  status text not null default 'DISCOVERED' check (status in (
    'DISCOVERED', 'SCORED', 'REJECTED', 'QUEUED', 'HUMAN_REVIEW'
  )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists job_search_candidates_status_idx on public.job_search_candidates (status);
create index if not exists job_search_candidates_score_idx on public.job_search_candidates (fit_score desc);
create index if not exists job_search_candidates_posted_idx on public.job_search_candidates (posted_at desc);

alter table public.job_search_candidates enable row level security;

-- ---------------------------------------------------------------------------
-- job_search_resume_variants
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_resume_variants (
  id uuid primary key default gen_random_uuid(),
  variant_key text not null unique check (variant_key in ('full_stack', 'backend_platform', 'ai_llm')),
  title text not null,
  status text not null default 'needs_verification' check (status in ('needs_verification', 'verified')),
  summary text,
  sections jsonb not null default '{}'::jsonb,
  source_fact_ids jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.job_search_resume_variants enable row level security;

-- ---------------------------------------------------------------------------
-- job_search_applications
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_applications (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.job_search_candidates (id) on delete cascade,
  resume_variant_id uuid references public.job_search_resume_variants (id) on delete set null,
  -- One application per candidate — the idempotency backbone. A re-run of
  -- the apply phase against the same candidate must upsert onto this row,
  -- never create a second one (regression test: "application execution is
  -- idempotent / duplicate-safe").
  status text not null default 'PREPARED' check (status in (
    'PREPARED', 'APPLYING', 'NEEDS_HUMAN', 'SUBMITTED', 'FAILED',
    'FOLLOWUP_DUE', 'INTERVIEW', 'REJECTED', 'OFFER'
  )),
  method text not null default 'not_applicable' check (method in ('automated_ats', 'manual', 'not_applicable')),
  needs_human_reason text,
  prepared_at timestamptz,
  submitted_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (candidate_id)
);

create index if not exists job_search_applications_status_idx on public.job_search_applications (status);

alter table public.job_search_applications enable row level security;

-- ---------------------------------------------------------------------------
-- job_search_application_answers
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_application_answers (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.job_search_applications (id) on delete cascade,
  question text not null,
  answer text,
  answer_source text not null check (answer_source in ('profile_fact', 'generated_safe', 'needs_human')),
  profile_fact_id uuid references public.job_search_profile_facts (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists job_search_application_answers_application_idx
  on public.job_search_application_answers (application_id);

alter table public.job_search_application_answers enable row level security;

-- ---------------------------------------------------------------------------
-- job_search_generated_artifacts
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_generated_artifacts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.job_search_applications (id) on delete cascade,
  artifact_type text not null check (artifact_type in ('resume', 'cover_letter')),
  resume_variant_id uuid references public.job_search_resume_variants (id) on delete set null,
  content text not null,
  traced_fact_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists job_search_generated_artifacts_application_idx
  on public.job_search_generated_artifacts (application_id);

alter table public.job_search_generated_artifacts enable row level security;

-- ---------------------------------------------------------------------------
-- job_search_followups
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_followups (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.job_search_applications (id) on delete cascade,
  followup_type text not null check (followup_type in ('confirmation_check', 'recruiter_reply', 'scheduled_followup', 'interview_request')),
  due_at timestamptz,
  completed_at timestamptz,
  -- Populated only by a future Gmail-correlation follow-up (see PR
  -- description) — nullable and unused by this migration's code.
  source_email_ref text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists job_search_followups_application_idx on public.job_search_followups (application_id);
create index if not exists job_search_followups_due_idx on public.job_search_followups (due_at) where completed_at is null;

alter table public.job_search_followups enable row level security;

-- ---------------------------------------------------------------------------
-- job_search_runs
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null check (run_type in ('source', 'score', 'apply', 'followup')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  -- Named run_trigger_source rather than the more obvious "triggered_by":
  -- lib/db/check-constraints.test.ts scans the whole repo for
  -- `<column>: 'literal'` once a column name is uniquely constrained by
  -- exactly one table, and "triggered_by" already exists elsewhere in the
  -- codebase as an unrelated free-text JSONB metadata key (unconstrained,
  -- different table, different meaning) — reusing that name here would
  -- make the scanner false-positive on that unrelated file.
  run_trigger_source text not null default 'cron' check (run_trigger_source in ('cron', 'founder-manual')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  stats jsonb not null default '{}'::jsonb,
  error text,
  business_date date not null default (now() at time zone 'utc')::date
);

create index if not exists job_search_runs_type_date_idx on public.job_search_runs (run_type, business_date);

-- SECURITY/CORRECTNESS: prevents two overlapping runs of the same phase
-- (e.g. two concurrent sourcing runs, both hitting Greenhouse/Lever and
-- racing to upsert the same candidates) rather than relying on application
-- code to check-then-insert, which would itself race. A second concurrent
-- insert for the same run_type while one is still 'running' fails this
-- constraint; the caller (lib/job-search/ingest.ts) catches that specific
-- violation and returns a clean "already running, skipped" result instead
-- of starting a duplicate run.
create unique index if not exists job_search_runs_one_running_per_type_idx
  on public.job_search_runs (run_type)
  where status = 'running';

alter table public.job_search_runs enable row level security;

-- ---------------------------------------------------------------------------
-- job_search_settings (singleton)
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_settings (
  id boolean primary key default true check (id),
  paused boolean not null default true,
  paused_reason text,
  paused_at timestamptz,
  daily_application_cap integer not null default 150,
  minimum_queue_score integer not null default 70,
  updated_at timestamptz not null default now()
);

comment on table public.job_search_settings is
  'Singleton (id is always true) founder control row. paused defaults to true: the apply phase must be explicitly unpaused by the founder after job_search_profiles/resume_variants are populated with real verified data. Sourcing/scoring/queue-building are unaffected by paused — only prepare_application / apply-phase execution checks it.';

alter table public.job_search_settings enable row level security;

insert into public.job_search_settings (id, paused, paused_reason)
values (true, true, 'Default safe state — founder must populate job_search_profiles with real verified facts and explicitly resume before any application preparation runs.')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- job_search_events (append-only audit log)
-- ---------------------------------------------------------------------------
create table if not exists public.job_search_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  entity_type text not null check (entity_type in (
    'candidate', 'application', 'profile_fact', 'resume_variant',
    'artifact', 'run', 'settings'
  )),
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now()
);

comment on table public.job_search_events is
  'Append-only audit trail for every sourced role, score, generated artifact, answer, submit action, failure, and escalation. Never updated or deleted by application code.';

create index if not exists job_search_events_entity_idx on public.job_search_events (entity_type, entity_id);
create index if not exists job_search_events_created_idx on public.job_search_events (created_at desc);

alter table public.job_search_events enable row level security;

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------

-- Placeholder founder profile — schema-shaped, NOT real biographical data.
-- Lamar must populate this with his real verified facts (education,
-- experience, skills, links, work authorization, location preferences)
-- before the pipeline is used for real applications. See PR description.
insert into public.job_search_profiles (
  status, full_name, headline, summary, education, skills, experience, links,
  work_authorization, location_preferences, target_titles
)
select
  'needs_verification',
  'NEEDS_VERIFICATION — replace with real name',
  'NEEDS_VERIFICATION — replace with real headline',
  'NEEDS_VERIFICATION — replace with a real, truthful summary before use.',
  '[{"institution": "NEEDS_VERIFICATION", "degree": "NEEDS_VERIFICATION", "field": "NEEDS_VERIFICATION", "graduation_date": "NEEDS_VERIFICATION"}]'::jsonb,
  '["NEEDS_VERIFICATION"]'::jsonb,
  '[{"employer": "NEEDS_VERIFICATION", "title": "NEEDS_VERIFICATION", "start_date": "NEEDS_VERIFICATION", "end_date": "NEEDS_VERIFICATION", "summary": "NEEDS_VERIFICATION"}]'::jsonb,
  '{"github": null, "portfolio": null, "linkedin": null}'::jsonb,
  '{"status": "NEEDS_VERIFICATION", "opt": true, "ead": true, "sponsorship_needed_future": "NEEDS_VERIFICATION"}'::jsonb,
  '{"current_location": "NEEDS_VERIFICATION", "open_to_relocation": "NEEDS_VERIFICATION", "open_to_remote": "NEEDS_VERIFICATION"}'::jsonb,
  '["Software Engineer I", "Junior Software Engineer", "Associate Software Engineer", "Full Stack Developer", "Backend Engineer", "AI Application Engineer"]'::jsonb
where not exists (select 1 from public.job_search_profiles);

-- Three truthful base resume variant shells (placeholder content).
insert into public.job_search_resume_variants (variant_key, title, status, summary, sections)
values
  ('full_stack', 'Software Engineer / Full Stack', 'needs_verification',
   'NEEDS_VERIFICATION — replace with real, truthful resume content.', '{}'::jsonb),
  ('backend_platform', 'Backend / Platform / API Engineer', 'needs_verification',
   'NEEDS_VERIFICATION — replace with real, truthful resume content.', '{}'::jsonb),
  ('ai_llm', 'AI / LLM Application Engineer', 'needs_verification',
   'NEEDS_VERIFICATION — replace with real, truthful resume content.', '{}'::jsonb)
on conflict (variant_key) do nothing;

-- Two real, compliant discovery sources (public JSON job-board APIs;
-- neither is LinkedIn nor Indeed and neither implies apply automation).
insert into public.job_search_sources (source_key, adapter_type, display_name, enabled, config)
values
  ('greenhouse_public', 'greenhouse', 'Greenhouse public job boards', true, '{"boards": []}'::jsonb),
  ('lever_public', 'lever', 'Lever public postings', true, '{"sites": []}'::jsonb)
on conflict (source_key) do nothing;
