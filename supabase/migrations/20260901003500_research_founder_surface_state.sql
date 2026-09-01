-- Deterministic projection state for founder-facing research updates.
-- Canonical research remains on research_questions; no parallel notification system.

alter table public.research_questions
  add column if not exists last_founder_surface_fingerprint text,
  add column if not exists last_founder_surface_confidence double precision
    check (last_founder_surface_confidence is null or last_founder_surface_confidence between 0 and 1),
  add column if not exists last_founder_surface_at timestamptz;

comment on column public.research_questions.last_founder_surface_fingerprint is
  'Semantic fingerprint of the last material investigation state projected into founder Direct. Equal fingerprints are suppressed.';
comment on column public.research_questions.last_founder_surface_confidence is
  'Mean claim confidence at the last founder-facing material update; sub-0.10 confidence-only movement is persisted silently.';
comment on column public.research_questions.last_founder_surface_at is
  'Timestamp of the last material founder-facing Direct projection.';
