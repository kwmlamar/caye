-- 2026-08-07 — business_fact_candidates lifecycle closure + provenance
--
-- Phase 1 of briefs/cold-start-plan.md.
--
-- WHY
-- business_fact_candidates has never produced a single fact. 8 rows exist across
-- two workspaces, every one still status='pending', max occurrence_count=1 — because
-- normalizeSentence dedups on exact string with zero fuzzy matching, and a human
-- never retypes a fact byte-identically. Confirmed from Bimini's own rows: "Meeting
-- Point: Resorts World Bimini Casino Tram Stop" and "...please take the complimentary
-- Resorts World Bimini tram from the pier to the Casino Tram Stop" are the same fact,
-- filed as two unmerged rows.
--
-- Separately: there has never been a code path that closes a proposed candidate.
-- add_business_fact writes straight to business_facts with source='owner-direct' and
-- never touches this table — a candidate that gets confirmed via the owner's "yes"
-- stays status='proposed' forever with no record of what it produced. Without that
-- link, decision 7 in the brief (a manual go/no-go on backfilling Bimini, informed by
-- how often the mechanism's inferences needed correcting) has nothing to look at.
--
-- WHAT THIS ADDS
--   business_fact_candidates.source        — which detector filed this. 'live_repeat'
--                                             for the existing reactive detector
--                                             (default, matches every current row's
--                                             actual origin); 'archive_mining' for the
--                                             Phase 2 rolling-window pass.
--   business_fact_candidates.outcome       — what actually happened when a proposal
--                                             was acted on. NULL until closed.
--     confirmed  — owner accepted the proposed text as-is
--     corrected  — owner accepted but changed the wording/content
--     ignored    — dismissed, or aged out unanswered (decision 6's cadence)
--   business_fact_candidates.outcome_at    — when it closed.
--   business_fact_candidates.resolved_fact_id
--                                           — the business_facts row this candidate
--                                             produced, if confirmed or corrected.
--
--   business_facts.source gains 'candidate-confirmed' alongside the existing
--   'owner-direct' / 'escalation-capture' — so a fact that came from this pipeline is
--   distinguishable from one the owner typed unprompted, the same provenance
--   discipline as bookings.source (20260807c).
--
-- Reversible: drop the four candidate columns, revert the business_facts check.

alter table public.business_fact_candidates
  add column if not exists source text not null default 'live_repeat';

alter table public.business_fact_candidates
  drop constraint if exists business_fact_candidates_source_check;

alter table public.business_fact_candidates
  add constraint business_fact_candidates_source_check
  check (source in ('live_repeat', 'archive_mining'));

alter table public.business_fact_candidates
  add column if not exists outcome text;

alter table public.business_fact_candidates
  drop constraint if exists business_fact_candidates_outcome_check;

alter table public.business_fact_candidates
  add constraint business_fact_candidates_outcome_check
  check (outcome is null or outcome in ('confirmed', 'corrected', 'ignored'));

alter table public.business_fact_candidates
  add column if not exists outcome_at timestamptz;

alter table public.business_fact_candidates
  add column if not exists resolved_fact_id uuid references public.business_facts (id) on delete set null;

comment on column public.business_fact_candidates.source is
  'Which detector filed this: live_repeat (reactive, exact-then-semantic match on owner replies) or archive_mining (Phase 2 rolling-window pass). See briefs/cold-start-plan.md.';
comment on column public.business_fact_candidates.outcome is
  'confirmed | corrected | ignored | null (still open). The signal behind the Bimini backfill go/no-go — decision 7.';

alter table public.business_facts
  drop constraint if exists business_facts_source_check;

alter table public.business_facts
  add constraint business_facts_source_check
  check (source in ('owner-direct', 'escalation-capture', 'candidate-confirmed'));
