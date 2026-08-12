-- Per-tool-call observability.
--
-- llm_call_log already answers "what did Caye spend?" per call site. Nothing
-- answered "what did Caye actually DO, and did it work?" — so when
-- add_internal_note failed on every call from the day it shipped, the only
-- trace was Caye apologising in a chat transcript. The failure was invisible
-- to every dashboard, alert, and query we had.
--
-- One row per tool execution, including retries, so both of these are a
-- single query:
--   "why did Caye fail to create this calendar event"
--   "which tools are failing, for whom, how often"

create table if not exists caye_tool_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,

  -- Correlates every tool call made while handling one inbound message.
  request_id text,
  operator_allowlist_id bigint,
  caller_role text,
  mode text,

  tool_name text not null,
  risk text,

  -- Taxonomy from lib/caye-agent/tools/result.ts.
  status text not null,
  error_code text,
  error text,

  -- 1 for a first-try success; >1 means the orchestrator retried.
  attempts int not null default 1,
  -- True when the effect was preserved locally and queued for external sync.
  deferred boolean not null default false,

  duration_ms int,
  created_at timestamptz not null default now()
);

-- "Show me this turn's tool calls" — the debugging entry point.
create index if not exists caye_tool_calls_request_idx
  on caye_tool_calls (request_id, created_at);

-- "What's failing for this workspace lately?"
create index if not exists caye_tool_calls_workspace_recent_idx
  on caye_tool_calls (workspace_id, created_at desc);

-- Failure-rate-by-tool, without scanning the successes.
create index if not exists caye_tool_calls_failures_idx
  on caye_tool_calls (tool_name, created_at desc)
  where status <> 'SUCCESS';

comment on table caye_tool_calls is
  'One row per tool execution attempt-group. attempts>1 means the orchestrator retried. Service-role only.';
comment on column caye_tool_calls.status is
  'SUCCESS | FAILED_RETRYABLE | FAILED_PERMANENT | NOT_FOUND | CONFLICT | NEEDS_HUMAN — the value after retries were exhausted.';

alter table caye_tool_calls enable row level security;
