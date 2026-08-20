-- CAY-14 (2026-08-18) — supersede conflicting business memory after owner
-- corrections.
--
-- WHY
-- business_facts has no notion of one fact replacing another. Production
-- incident: an older fact ("All payments are made in advance by card
-- only... Cash and Zelle are not accepted.") stayed active after a later
-- owner policy shifted payment handling — Caye told a guest (Juli King)
-- cash wasn't accepted, the owner (Mrs. Max) had to correct that live in
-- the conversation, and the delay contributed to losing the booking.
-- add_business_fact only ever appends; nothing ever marked the earlier
-- fact retired, so both stood "equally active" in retrieval with no
-- signal which one currently governs.
--
-- WHAT THIS ADDS
-- Same shape as caye_pending_actions.superseded_by (20260816b): the
-- superseded row is never mutated or deleted, only marked. Full history
-- stays queryable (old row -> superseded_by -> the fact that replaced
-- it), satisfying "do not hard-delete historical facts" while giving
-- normal retrieval (fetchBusinessFacts, query_business_knowledge) a
-- single boolean to filter on.
--
--   business_facts.superseded_by  — id of the fact that replaced this one.
--   business_facts.superseded_at  — when that happened.
--
-- Both nullable; most facts never get superseded. No backfill — every
-- existing row starts active (superseded_at is null), which is a no-op
-- change in behavior for current facts. This migration does not touch
-- any existing row's data, only adds columns.
--
-- Reversible: drop the two columns.

alter table public.business_facts
  add column if not exists superseded_by uuid references public.business_facts (id) on delete set null;

alter table public.business_facts
  add column if not exists superseded_at timestamptz;

comment on column public.business_facts.superseded_by is
  'Set when a newer fact (an owner correction outranking this one) replaced it. The row and its original fact text are preserved for audit — only superseded_at + this column are written, never fact/category.';
comment on column public.business_facts.superseded_at is
  'When this fact was superseded. Null means still active. fetchBusinessFacts and query_business_knowledge filter superseded rows out of normal retrieval.';

create index if not exists business_facts_active_idx
  on public.business_facts (workspace_id)
  where superseded_at is null;
