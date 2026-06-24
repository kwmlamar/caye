-- 2026-06-25 — caye_escalations (#50)
--
-- Tracks every front-desk escalation Caye opens via the escalate_to_team tool.
-- One row per escalation event (not per ping recipient — route_to='both' is
-- still one escalation row, two outbound queue rows).
--
-- Used by:
--   * /api/caye/escalation-followup cron — finds unanswered escalations >6h
--     old and queues a customer reassurance + re-ping to the humans.
--   * Future analytics — what categories escalate most, where the
--     install-and-go gaps are.
--
-- "Resolved" is derived (any outbound business message on the conversation
-- after created_at counts — same shape as outbound-worker's
-- operatorRepliedDirectly check), not stored explicitly. owner_responded_at
-- is denormalized by the follow-up cron so it doesn't re-fire reassurance
-- after the operator already replied.

create table if not exists public.caye_escalations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  conversation_id uuid references public.unified_conversations(id) on delete set null,
  category text not null check (category in ('gap', 'policy', 'knowledge', 'sensitive')),
  route_to text not null check (route_to in ('owner', 'founder', 'both')),
  customer_facing_message text not null,
  internal_context text not null,
  created_at timestamptz not null default now(),
  -- Set when the follow-up cron observes an operator reply on the conversation.
  owner_responded_at timestamptz,
  -- Set when the 6h reassurance + re-ping has been sent.
  follow_up_sent_at timestamptz
);

create index if not exists caye_escalations_workspace_idx
  on public.caye_escalations (workspace_id);

create index if not exists caye_escalations_open_idx
  on public.caye_escalations (created_at)
  where owner_responded_at is null and follow_up_sent_at is null;

alter table public.caye_escalations enable row level security;
