-- Phase 3 convergence: persist structured front-desk agent turns
-- (tool_use/tool_result blocks) so a new customer message can reconstruct
-- what the converged front-desk agent already checked, without putting
-- agent-internal turns in unified_messages (the customer-visible ledger
-- read by the founder inbox, contact profiles, and every channel history
-- view). Sibling pattern to caye_operator_messages' claude_format column
-- (back-office) and caye_admin_shell_messages' dedicated-table shape
-- (admin shell) — deliberately a SEPARATE table, not a shared one, so no
-- consumer of unified_messages needs new filtering logic to avoid
-- rendering a tool_use/tool_result turn as a customer-facing bubble.
--
-- Not wired into any production webhook by this migration alone — see
-- lib/caye-frontdesk-agent-turns.ts for the read/write layer and
-- lib/caye-agent/context.ts's loadFrontDeskConversationContext for the
-- context loader that consumes it.
create table if not exists public.caye_frontdesk_agent_turns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  conversation_id uuid not null references public.unified_conversations(id) on delete cascade,
  triggering_message_id uuid references public.unified_messages(id) on delete set null,
  sequence int not null,
  role text not null check (role in ('user', 'assistant')),
  claude_format jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists caye_frontdesk_agent_turns_conversation_idx
  on public.caye_frontdesk_agent_turns (workspace_id, conversation_id, created_at);

-- Idempotency backstop: a webhook/provider retry that re-runs the same
-- agent invocation for the same inbound message must not duplicate its
-- persisted turns. sequence is assigned in-order by the writer for a
-- single invocation, so (conversation_id, triggering_message_id, sequence)
-- uniquely identifies one turn of one invocation; a retried write hits
-- this constraint (23505) and the writer treats that as "already
-- persisted," not an error. NULL triggering_message_id (e.g. a
-- dashboard-originated or synthetic turn with no customer message to
-- key off) is intentionally excluded from the constraint.
create unique index if not exists caye_frontdesk_agent_turns_trigger_seq_idx
  on public.caye_frontdesk_agent_turns (conversation_id, triggering_message_id, sequence)
  where triggering_message_id is not null;

alter table public.caye_frontdesk_agent_turns enable row level security;
-- Service-role only, same deny-by-default pattern as caye_operator_messages
-- / caye_admin_shell_messages: zero policies means anon/authenticated roles
-- get nothing, and the only caller is the runtime's own service-role
-- client (lib/supabase-server.ts's createServiceClient()) after its own
-- workspace/role checks upstream. No anon/authenticated policy is needed.

comment on table public.caye_frontdesk_agent_turns is
  'Structured Anthropic MessageParam turns (tool_use/tool_result included) for the converged front-desk agent, keyed per workspace+conversation. NOT customer-visible — unified_messages remains the authoritative record of what the customer and business actually exchanged. Read by the front-desk context loader to reconstruct agent continuity across turns; never rendered directly.';
