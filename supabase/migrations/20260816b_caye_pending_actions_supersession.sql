-- Phase 3 convergence (Part E) — explicit refinement/supersession for
-- staged high-risk actions.
--
-- Before this: refining a staged draft (owner says "add safe travels to
-- it") calls the same tool again with revised args, which stages a
-- SECOND row under a different args_key — correct, since args must stay
-- immutable once shown for confirmation (mutating a shown draft in place
-- would let what the operator reviewed and what runs drift apart, the
-- exact bug gateHighRisk's own design doc warns against). But the FIRST
-- row was left to expire silently on its own TTL rather than being
-- explicitly retired, so two "awaiting confirmation" rows for the same
-- underlying target (same conversation/booking) could coexist with
-- nothing in the data recording that the first was superseded rather
-- than abandoned.
--
-- This column lets gateHighRisk (lib/caye-agent/tools/high-risk-gate.ts)
-- record that explicitly: when a new staging targets the same
-- (workspace, operator, tool, conversation/booking) as an existing
-- not-yet-executed row, the OLD row is cancelled with superseded_by
-- pointing at the NEW row's id — its args are never mutated, so the
-- original draft remains in the audit trail exactly as staged.
alter table public.caye_pending_actions
  add column if not exists superseded_by uuid references public.caye_pending_actions(id) on delete set null;

comment on column public.caye_pending_actions.superseded_by is
  'Set when a newer staged action for the same target replaced this one before it was confirmed. The row and its original args are preserved for audit — only cancelled_at + this column are written, never args/summary.';
