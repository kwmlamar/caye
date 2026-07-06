-- 2026-07-05 — business_fact_candidates
--
-- Detects business facts Max is already teaching guests by hand, over and
-- over, without ever going through add_business_fact. Confirmed live
-- (Bridgette Jones / Bimini, 2026-07-04/05): pickup point, phone numbers,
-- and cancellation policy were retyped near-verbatim across 15+
-- conversations from 2026-04-27 through 2026-07-05, none of it captured.
--
-- Every human-authored (sent_by='human') business message is fingerprinted
-- sentence-by-sentence; matching fingerprints across DISTINCT conversations
-- accumulate here. At occurrence_count = 3, Caye proposes the fact to the
-- owner in back-office chat (see lib/business-fact-suggestions.ts) instead
-- of silently waiting for someone to notice.
--
-- Deliberately excludes anything that looks like it rotates per-booking
-- (guide names, day-of pricing/availability) — see the normalization rules
-- in code; this table only ever accumulates stable, reusable snippets.

create table if not exists public.business_fact_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  normalized_text text not null,
  sample_text text not null,
  category_guess text not null check (category_guess in ('policy', 'service_detail', 'special_handling', 'logistics')),
  conversation_ids jsonb not null default '[]'::jsonb,
  occurrence_count integer not null default 1,
  status text not null default 'pending' check (status in ('pending', 'proposed', 'resolved', 'dismissed')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  proposed_at timestamptz,
  unique (workspace_id, normalized_text)
);

create index if not exists business_fact_candidates_workspace_idx
  on public.business_fact_candidates (workspace_id);

create index if not exists business_fact_candidates_workspace_status_idx
  on public.business_fact_candidates (workspace_id, status);

alter table public.business_fact_candidates enable row level security;
