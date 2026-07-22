-- Demo mode (2026-07-22) — lets an already-onboarded operator preview
-- Caye's guest-facing voice in the SAME WhatsApp thread they onboarded
-- on, roleplaying as if they were their own customer. Distinct from
-- demo_prospects (a founder-led sales tool for cold, unregistered
-- phones with no operator_allowlist row) — this is for a real,
-- already-verified operator (owner/staff/founder), triggered by a
-- keyword or template button, exited by keyword or 30-min idle.
--
-- Deliberately NOT sharing caye_operator_messages (mirrors the
-- caye_admin_shell_messages precedent, 20260721d): a demo roleplay
-- turn is not real back-office conversation and must never bleed into
-- the back-office agent's sliding-window memory or any guest-facing
-- metric. demo_sessions doubles as the founder-adoption-tracking
-- record — no separate analytics table needed.

create table if not exists public.demo_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  operator_allowlist_id bigint references public.operator_allowlist(id) on delete set null,
  phone text not null,
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at timestamptz,
  exit_reason text check (exit_reason in ('keyword', 'idle_timeout')),
  message_count int not null default 0
);

-- At most one active (ended_at is null) session per operator per workspace.
create unique index if not exists demo_sessions_active_idx
  on public.demo_sessions (workspace_id, operator_allowlist_id)
  where ended_at is null;

create index if not exists demo_sessions_workspace_idx
  on public.demo_sessions (workspace_id, started_at desc);

comment on table public.demo_sessions is
  'One row per operator-initiated demo-roleplay session. ended_at is null while active. Also the founder-adoption-tracking record (Q8) -- message_count/exit_reason answer "is this feature landing" without needing transcript access.';

create table if not exists public.demo_session_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.demo_sessions(id) on delete cascade,
  role text not null check (role in ('guest', 'caye')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists demo_session_messages_session_idx
  on public.demo_session_messages (session_id, created_at);

comment on table public.demo_session_messages is
  'Roleplay turn history for a demo_sessions row. Isolated storage so demo conversations never touch unified_conversations/unified_messages (guest data) or caye_operator_messages (real back-office memory).';

alter table public.demo_sessions enable row level security;
alter table public.demo_session_messages enable row level security;
-- Service-role only, same access pattern as caye_admin_shell_messages --
-- the operator webhook always uses createServiceClient(), so no
-- anon/authenticated policy is needed.

-- Template registry row for the post-onboarding demo offer. status
-- stays 'pending' until the matching template (body text below, plus
-- two quick-reply buttons -- "Demo" / "No thanks" -- configured
-- directly in Meta Business Manager, same as caye_driver_consent's
-- "OK" button) is submitted there and approved. sendDemoOffer()
-- (lib/caye-demo.ts) checks this row's status at send time and falls
-- back to a plain-text offer while pending, mirroring the
-- morningDigestSupports4Placeholders gating pattern.
insert into public.whatsapp_templates (name, category, body_template, placeholder_count, status)
values (
  'caye_demo_offer',
  'utility',
  'Want to see how I''ll sound to your guests, {{1}}? Tap Demo and I''ll roleplay as if you''re one of your own customers.',
  1,
  'pending'
)
on conflict (name) do nothing;
