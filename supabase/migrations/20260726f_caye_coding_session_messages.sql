-- Founder coding-agent panel (2026-07-26) — per-turn output for a
-- caye_coding_sessions row. Mirrors caye_admin_shell_messages' shape
-- (append-only, `direction`-style discriminator, raw payload alongside a
-- human-readable body) but FK'd to a session and using a richer `kind`
-- discriminator (a session has many turn *types* — tool calls, file
-- edits, commits — not just inbound/outbound).
create table if not exists public.caye_coding_session_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.caye_coding_sessions(id) on delete cascade,
  kind text not null check (
    kind in ('assistant_text', 'tool_call', 'tool_result', 'file_edit', 'commit', 'system', 'error', 'summary')
  ),
  body text not null,
  raw jsonb,
  created_at timestamptz not null default now()
);

create index if not exists caye_coding_session_messages_session_idx
  on public.caye_coding_session_messages (session_id, created_at);

alter table public.caye_coding_session_messages enable row level security;
-- Service-role only — same reasoning as caye_coding_sessions.
