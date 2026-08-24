-- The boolean remains the execution gate. Existing paused rows are unknown,
-- never owner-resumable, because their original cause was not persisted.
alter table public.workspace_ai_config
  add column if not exists outreach_pause_source text,
  add column if not exists outreach_pause_reason text,
  add column if not exists outreach_paused_at timestamptz;

alter table public.workspace_ai_config
  add constraint workspace_ai_config_outreach_pause_source_check
  check (outreach_pause_source is null or outreach_pause_source in ('owner_manual', 'bounce_kill_switch'));

create table if not exists public.caye_outreach_pause_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  action text not null check (action in ('paused', 'resumed')),
  source text not null check (source in ('owner_manual', 'bounce_kill_switch')),
  reason text,
  actor_role text not null check (actor_role in ('owner', 'founder', 'system')),
  created_at timestamptz not null default now()
);
create index if not exists caye_outreach_pause_events_workspace_created_idx on public.caye_outreach_pause_events (workspace_id, created_at desc);
alter table public.caye_outreach_pause_events enable row level security;
