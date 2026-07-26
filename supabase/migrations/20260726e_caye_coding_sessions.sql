-- Founder coding-agent panel (2026-07-26) — one row per `/code <task>`
-- session, mutated in place across cron poll ticks. Mirrors
-- caye_cron_runs' single-row-lifecycle shape rather than an append-only
-- messages table, since this table tracks ONE session's status over
-- time, not a conversation. Per-turn output lives separately in
-- caye_coding_session_messages (20260726f).
--
-- This table never holds Supabase/product credentials — the sandbox
-- itself only ever gets a repo-scoped GitHub PAT + a dedicated Anthropic
-- key (see lib/coding-session/boot.ts), so a compromised sandbox can't
-- reach this table or any other part of Caye's data directly.
create table if not exists public.caye_coding_sessions (
  id uuid primary key default gen_random_uuid(),
  task text not null,
  requested_by uuid not null,
  status text not null check (
    status in ('booting', 'running', 'testing', 'pushed', 'failed', 'timed_out', 'killed')
  ) default 'booting',
  sandbox_name text,
  cmd_id text,
  output_cursor bigint not null default 0,
  base_commit_sha text,
  final_commit_sha text,
  gate_test_passed boolean,
  gate_build_passed boolean,
  gate_output text,
  kill_requested boolean not null default false,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  timeout_at timestamptz,
  last_polled_at timestamptz,
  finished_at timestamptz
);

create index if not exists caye_coding_sessions_active_idx
  on public.caye_coding_sessions (status)
  where status in ('booting', 'running', 'testing');

create index if not exists caye_coding_sessions_created_idx
  on public.caye_coding_sessions (created_at desc);

alter table public.caye_coding_sessions enable row level security;
-- Service-role only, same access pattern as every other founder table —
-- the API routes (app/api/founder/coding-session/*, the cron poll route)
-- always use createServiceClient() after their own requireFounder()/
-- CRON_SECRET check, so no anon/authenticated policy is needed.
