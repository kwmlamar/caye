-- Admin Shell (2026-07-21) — founder-only dev/ops chat console, a sibling
-- of Caye Direct (caye_operator_messages) but deliberately NOT sharing
-- that table: this is a single, global, workspace-less founder thread,
-- not a per-workspace/per-operator business-ops history.
create table if not exists public.caye_admin_shell_messages (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null,
  claude_format jsonb,
  created_at timestamptz not null default now()
);

create index if not exists caye_admin_shell_messages_created_idx
  on public.caye_admin_shell_messages (created_at desc);

alter table public.caye_admin_shell_messages enable row level security;
-- Service-role only, same access pattern as caye_operator_messages — the
-- API route (app/api/founder/admin-shell/route.ts) always uses
-- createServiceClient() after its own isFounderUserId() check, so no
-- anon/authenticated policy is needed.
