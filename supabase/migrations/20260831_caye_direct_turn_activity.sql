-- Ephemeral founder-visible turn activity for Caye Direct.
-- Service-role only: this is operational telemetry, not customer data.
create table if not exists public.caye_direct_turn_activity (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  thread_id uuid not null,
  kind text not null check (kind in ('thinking','analyzing_image','calling_tool','completed','failed')),
  label text,
  tool_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_caye_direct_turn_activity_thread_updated
  on public.caye_direct_turn_activity (workspace_id, thread_id, updated_at desc);

alter table public.caye_direct_turn_activity enable row level security;
-- Intentionally no client RLS policies. Founder API routes use the service role
-- after requireFounder(); customers can never read or write this table directly.
