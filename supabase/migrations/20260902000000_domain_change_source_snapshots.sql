-- Change-detection state for polled domain sources.
--
-- Integration follow-up to 20260901190000_business_entity_kernel.sql and
-- 20260901_domain_event_projection_bridge.sql. Neither of those owns this
-- concern: the kernel stores identity, and the bridge's
-- domain_entity_observation_state records what has already been PROJECTED.
-- This table records what was last OBSERVED, which is what a polling adapter
-- needs to tell "status moved from approved to ordered" apart from "status is
-- ordered and always was".
--
-- Explicitly not a mirror of the source system:
--   * only the small set of semantically tracked fields is kept;
--   * it is never read to answer "what is this record now" — that question
--     goes to the source system through its read adapter;
--   * truncating it costs one round of bootstrap observations, never a fact.

create table if not exists public.domain_change_source_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  source_system text not null,
  source_company_id text not null,
  source_entity_type text not null,
  source_entity_id text not null,
  -- sha256 over the canonicalised tracked fields. Compared, never parsed.
  fingerprint text not null,
  -- The tracked fields themselves, so a transition can report a real previous
  -- value rather than an opaque "something changed".
  fields jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_system, source_company_id, source_entity_type, source_entity_id)
);

create index if not exists domain_change_source_snapshots_stream_idx
  on public.domain_change_source_snapshots (workspace_id, source_system, source_entity_type);

-- Service-role only, matching the rest of the domain ingestion surface. RLS is
-- enabled with no policies on purpose: this is deny-by-default for every
-- client-facing role, which is the intended terminal state and not an
-- unfinished policy set. Nothing in a browser has any business reading another
-- system's change-detection state.
alter table public.domain_change_source_snapshots enable row level security;
revoke all on table public.domain_change_source_snapshots from public, anon, authenticated;
grant select, insert, update, delete on table public.domain_change_source_snapshots to service_role;

comment on table public.domain_change_source_snapshots is
  'Last observed tracked-field snapshot per external entity, for polled change detection. Never authoritative business state; safe to truncate at the cost of re-bootstrapping.';
