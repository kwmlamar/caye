-- Fully-autonomous cold outreach (decisions-log 2026-08-12, reversing the
-- 2026-07-21 "step 4 permanently off" decision). Four pieces:
--   1. Link-tracking + a "tried Caye" status on outreach_leads, so the demo
--      CTA has a real per-lead signal instead of nothing.
--   2. A fixed sourcing target list, so autonomous sourcing stays bounded
--      to the documented ICP rather than picking its own verticals/geos.
--   3. Two new outreach-specific workspace_ai_config flags, deliberately
--      separate from the workspace-wide whatsapp_muted_until pause, so an
--      automatic bounce-triggered trip stops cold sending without also
--      silently stopping Caye from answering a lead who already replied.
--   4. Flips customers.autosend_enabled on for internal_sales, which is
--      what actually makes reply-handling autonomous (autosend-gate.ts
--      reads this boolean directly — it doesn't care about the
--      workspace-config route's UI lock, which is a separate, later fix).

alter table public.outreach_leads
  add column demo_token text unique default encode(gen_random_bytes(6), 'hex'),
  add column tried_at timestamptz;

comment on column public.outreach_leads.demo_token is
  'Per-lead token embedded in the demo CTA link (app/api/r/[token]). Hitting it stamps tried_at and flips status to tried — the exit condition that stops further follow-ups, distinct from converted (paying). Chosen over email-match: a prospect trying the demo via a different address/number than the one emailed (common — the WhatsApp demo is often tried from a personal phone) would silently break email matching.';

-- No CHECK constraint exists on status (20260721c documents the vocabulary
-- in a comment, not an enforced constraint) — 'sourced' and 'tried' just
-- extend that documented vocabulary, nothing to alter.
comment on column public.outreach_leads.status is
  'sourced | draft | sent | tried | replied | converted | cold | do_not_contact — sourced (new) is a cron-created row with no draft yet. tried (new) means the lead completed the WhatsApp demo via demo_token, before any paid conversion (converted, still separately tracked and still unset by any code as of this migration).';

create table public.outreach_sourcing_targets (
  id uuid primary key default gen_random_uuid(),
  vertical text not null,
  region text not null,
  priority integer not null default 100,
  active boolean not null default true,
  last_sourced_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  unique (vertical, region)
);

comment on table public.outreach_sourcing_targets is
  'Fixed vertical x region list the autonomous sourcing cron (app/api/caye/outreach-sourcing-scan) works through in priority order. Deliberately not something the cron can add rows to itself — decisions-log 2026-08-12: Caye can propose a new vertical/region in conversation, she does not get to add one unilaterally. Seeded from Products/Caye/ICP.md (Caribbean tour operators/restaurants/salons/guesthouses, Bahamas-first). Regions already touched via manual scripts/source-leads.ts runs but outside that ICP — Zanzibar, Bali, Turks & Caicos, Puerto Rico — are deliberately NOT seeded here; that drift predates this decision and is not retroactively blessed by it.';

insert into public.outreach_sourcing_targets (vertical, region, priority) values
  ('tour operator', 'Nassau, Bahamas', 10),
  ('tour operator', 'Freeport, Bahamas', 15),
  ('tour operator', 'Exuma, Bahamas', 20),
  ('restaurant', 'Nassau, Bahamas', 25),
  ('salon', 'Nassau, Bahamas', 30),
  ('guesthouse', 'Nassau, Bahamas', 35),
  ('tour operator', 'Kingston, Jamaica', 40),
  ('tour operator', 'Montego Bay, Jamaica', 45),
  ('tour operator', 'Port of Spain, Trinidad and Tobago', 50),
  ('tour operator', 'Bridgetown, Barbados', 55);

alter table public.outreach_sourcing_targets enable row level security;

alter table public.workspace_ai_config
  add column outreach_autosend_paused boolean not null default true,
  add column outreach_bounce_threshold integer not null default 5,
  add column outreach_bounce_window_hours integer not null default 24;

comment on column public.workspace_ai_config.outreach_autosend_paused is
  'internal_sales-only kill switch for autonomous cold first-touch/follow-up sends (decisions-log 2026-08-12). Deliberately separate from customers.autosend_enabled (which now also gates reply autonomy) and from whatsapp_muted_until (the workspace-wide manual pause) — an automatic bounce-triggered trip here must not silently stop Caye from answering a lead who already replied. Defaults true (paused) on this migration: nothing autonomous sources or sends until a founder reviews real output and flips this off via the dashboard.';

comment on column public.workspace_ai_config.outreach_bounce_threshold is
  'Bounce count in the trailing outreach_bounce_window_hours that trips outreach_autosend_paused automatically (lib/outreach-kill-switch.ts). Starting number, no real baseline exists yet — _Ops/Outreach/outreach-tracker.md''s Weekly Totals table was still empty as of this migration despite ~2.5 weeks at volume. Tune once real bounce data exists.';

-- Reply-handling autonomy reversal: the 2026-07-21 roadmap hard-set this
-- false for internal_sales via scripts/seed-tropitech-sales-workspace.ts.
-- Reversed 2026-08-12 — see decisions-log. Keyed on workspace_kind, not a
-- hardcoded workspace id, since this must survive workspace re-seeding.
update public.customers
  set autosend_enabled = true
  where workspace_kind = 'internal_sales';
