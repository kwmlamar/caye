-- Caye AI Gateway: provider independence, health, and routing telemetry.
--
-- Context: Caye was coupled to one AI vendor. An exhausted Anthropic balance
-- returns HTTP 400 (observed 2026-08-31, 14 failed production research runs),
-- which failed customer-facing and autonomous workflows outright. The gateway
-- (lib/ai) treats every provider as replaceable; these tables are the shared
-- state that makes that safe across multiple serverless instances.
--
-- All three tables are internal infrastructure. Service-role only, no
-- workspace scoping, and never read as business memory.

-- ---------------------------------------------------------------------------
-- Provider health / circuit breaker. One row per provider, three rows total.
-- Shared so a provider found to be out of credit on instance A is not
-- re-probed by instance B on the very next request.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_provider_health (
  provider text primary key check (provider in ('anthropic', 'openai', 'openrouter')),
  state text not null default 'healthy' check (state in ('healthy', 'cooldown')),
  -- Error category that opened the circuit (lib/ai/types.ts AIErrorCategory).
  reason text,
  -- Safe, truncated provider message. Never a key, token or stack.
  detail text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  cooldown_until timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  -- Non-reversible fingerprint of the credential in use when the circuit
  -- opened, so rotating a key or topping up an account releases a long
  -- billing/auth cooldown immediately instead of waiting it out.
  credential_fingerprint text,
  updated_at timestamptz not null default now()
);

alter table public.ai_provider_health enable row level security;

-- ---------------------------------------------------------------------------
-- Founder-controlled provider configuration. An absent row means "enabled,
-- no priority override", so an empty table is a valid production state.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_provider_settings (
  provider text primary key check (provider in ('anthropic', 'openai', 'openrouter')),
  enabled boolean not null default true,
  -- Lower sorts earlier. Null leaves the compiled per-task route untouched.
  priority integer,
  updated_at timestamptz not null default now()
);

alter table public.ai_provider_settings enable row level security;

-- ---------------------------------------------------------------------------
-- Routing telemetry, added to the existing spend ledger rather than a second
-- table, so /api/admin/llm-spend and /api/founder/command-overview cannot
-- drift from routing reality. Additive and nullable: every historical row
-- stays valid, and lib/llm-telemetry.ts's generic sink still writes without
-- these columns.
-- ---------------------------------------------------------------------------
alter table public.llm_call_log
  add column if not exists provider text,
  add column if not exists task text,
  add column if not exists outcome text,
  add column if not exists failure_category text,
  add column if not exists fallback_used boolean,
  add column if not exists latency_ms integer,
  -- Full ordered attempt trail, including providers that were skipped and
  -- why. A failover nobody can see is indistinguishable from a provider
  -- that never fails.
  add column if not exists attempts jsonb;

alter table public.llm_call_log
  drop constraint if exists llm_call_log_provider_check;

alter table public.llm_call_log
  add constraint llm_call_log_provider_check
  check (provider is null or provider in ('anthropic', 'openai', 'openrouter'));

alter table public.llm_call_log
  drop constraint if exists llm_call_log_outcome_check;

alter table public.llm_call_log
  add constraint llm_call_log_outcome_check
  check (outcome is null or outcome in ('success', 'failure'));

create index if not exists llm_call_log_provider_called_at_idx
  on public.llm_call_log (provider, called_at desc)
  where provider is not null;

create index if not exists llm_call_log_task_called_at_idx
  on public.llm_call_log (task, called_at desc)
  where task is not null;

-- "How often is failover happening, and which provider is failing?"
create index if not exists llm_call_log_fallback_called_at_idx
  on public.llm_call_log (called_at desc)
  where fallback_used is true or outcome = 'failure';
