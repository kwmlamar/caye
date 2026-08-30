-- CHAT 2: outcome-driven adaptive learning.
-- Reuses business_fact_candidates as quarantine and business_facts as validated typed memory.

alter table public.business_fact_candidates
  add column if not exists confidence numeric,
  add column if not exists canonical_key text,
  add column if not exists evidence_refs jsonb not null default '[]'::jsonb;

alter table public.business_fact_candidates
  drop constraint if exists business_fact_candidates_source_check;

alter table public.business_fact_candidates
  add constraint business_fact_candidates_source_check
  check (source = any (array['live_repeat'::text, 'archive_mining'::text, 'outcome_learning'::text]));

alter table public.business_fact_candidates
  drop constraint if exists business_fact_candidates_confidence_check;

alter table public.business_fact_candidates
  add constraint business_fact_candidates_confidence_check
  check (confidence is null or (confidence >= 0 and confidence <= 1));

alter table public.business_fact_candidates
  drop constraint if exists business_fact_candidates_evidence_refs_check;

alter table public.business_fact_candidates
  add constraint business_fact_candidates_evidence_refs_check
  check (jsonb_typeof(evidence_refs) = 'array');

create index if not exists business_fact_candidates_outcome_learning_idx
  on public.business_fact_candidates (workspace_id, canonical_key, status, last_seen_at desc)
  where source = 'outcome_learning';

comment on column public.business_fact_candidates.evidence_refs is
  'Structured evidence references for quarantined learning candidates. Outcome-learning refs are workspace-local project/verdict/prediction/outcome identifiers; candidate state is not live policy.';

comment on column public.business_fact_candidates.confidence is
  'Evidence confidence for a quarantined candidate. Confidence affects validation/ranking only and never outranks explicit human knowledge.';

comment on column public.business_fact_candidates.canonical_key is
  'Canonical typed-memory key that a validated candidate may eventually resolve into. Candidate rows remain non-authoritative until resolved.';
