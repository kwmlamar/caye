-- Admin Shell (2026-07-21) — parallel high-risk confirmation gate for the
-- founder-only admin-shell agent mode. Mirrors caye_pending_actions'
-- mechanism (lib/caye-agent/tools/high-risk-gate.ts) exactly, but WITHOUT
-- its workspace_id/operator_id scoping: admin-shell has no workspace and
-- a single caller (the founder), so that table's constraints don't fit.
-- Deliberately a separate table rather than loosening
-- caye_pending_actions' NOT NULL workspace FK — that table is the safety
-- rail for customer-facing high-risk actions and isn't touched here.
create table if not exists public.caye_admin_pending_actions (
  id uuid primary key default gen_random_uuid(),
  tool_name text not null,
  args jsonb not null,
  args_key text not null,
  summary text not null,
  created_in_request_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  executed_at timestamptz,
  cancelled_at timestamptz,
  result jsonb
);

create index if not exists caye_admin_pending_actions_lookup_idx
  on public.caye_admin_pending_actions (tool_name, args_key)
  where executed_at is null and cancelled_at is null;

alter table public.caye_admin_pending_actions enable row level security;
