-- 2026-07-12 — caye_pending_actions
--
-- Code-enforced confirmation gate for HIGH-RISK back-office tools
-- (send_reply, confirm/reschedule/cancel_booking, remove_service,
-- remove_blackout_date, remove_team_member). Previously the "draft,
-- ask, wait for yes" confirmation flow lived entirely in the system
-- prompt — a single bad model turn (or a prompt-injected instruction
-- surfacing from a tool result) could execute a real customer send or
-- cancellation with nothing in code to catch it.
--
-- One row is staged the first time a given (workspace, operator, tool,
-- args) combination is seen. The mutation only actually runs when the
-- SAME tool+args is seen again from a DIFFERENT top-level agent request
-- (a fresh inbound WhatsApp message) — see gateHighRisk() in
-- lib/caye-agent/tools/high-risk-gate.ts. That guarantees a real human
-- turn happened between staging and execution, regardless of how many
-- tool-loop iterations the model burns retrying within one request.

create table if not exists public.caye_pending_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  -- Null only for legacy callers with no resolved operator_allowlist row
  -- (mirrors caye_operator_messages.operator_allowlist_id nullability).
  operator_id bigint references public.operator_allowlist(id) on delete cascade,
  tool_name text not null,
  args jsonb not null,
  -- Stable (sorted-key) JSON of args — how repeat calls are matched
  -- against an already-staged action without a model-supplied token.
  args_key text not null,
  summary text not null,
  -- The runToolLoop request that first staged this row. A same-request
  -- retry must not execute — see gateHighRisk().
  created_in_request_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  executed_at timestamptz,
  cancelled_at timestamptz,
  result jsonb
);

create index if not exists caye_pending_actions_lookup_idx
  on public.caye_pending_actions (workspace_id, tool_name, args_key)
  where executed_at is null and cancelled_at is null;

alter table public.caye_pending_actions enable row level security;
