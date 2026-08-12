-- Bounce log backing lib/outreach-kill-switch.ts (decisions-log 2026-08-12).
-- One row per classified bounce/NDR (lib/sender-classifier.ts's
-- isBounceNotification) on the internal_sales workspace's inbox. Counted
-- over a trailing window (workspace_ai_config.outreach_bounce_window_hours)
-- against a threshold (outreach_bounce_threshold) to auto-trip
-- outreach_autosend_paused. A proxy signal, not a true bounce API — see
-- that file's doc comment.

create table public.caye_outreach_bounces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index caye_outreach_bounces_workspace_created_idx
  on public.caye_outreach_bounces (workspace_id, created_at);

comment on table public.caye_outreach_bounces is
  'One row per classified bounce/NDR on a workspace''s outreach inbox. Append-only — no delete/expiry needed, the kill-switch query only reads the trailing window.';

alter table public.caye_outreach_bounces enable row level security;
