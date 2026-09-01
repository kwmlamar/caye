-- Durable founder-visible execution state for Caye Direct.
-- Threads remain the conversation object. Runs exist only while work is alive.
create table if not exists public.caye_direct_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  thread_id uuid not null references public.caye_direct_threads(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','planning','running','waiting_user','paused','completed','failed','cancelled')),
  objective text not null,
  stage_label text,
  control_requested text check (control_requested is null or control_requested in ('pause','cancel')),
  pending_steering text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists caye_direct_runs_thread_recent_idx on public.caye_direct_runs(thread_id, updated_at desc);
create index if not exists caye_direct_runs_active_idx on public.caye_direct_runs(status, updated_at desc) where status in ('queued','planning','running','waiting_user','paused');

create table if not exists public.caye_direct_run_events (
  id bigserial primary key,
  run_id uuid not null references public.caye_direct_runs(id) on delete cascade,
  kind text not null check (kind in ('status','activity','steering','control','artifact')),
  label text not null,
  created_at timestamptz not null default now()
);
create index if not exists caye_direct_run_events_run_idx on public.caye_direct_run_events(run_id, created_at asc);

alter table public.caye_direct_runs enable row level security;
alter table public.caye_direct_run_events enable row level security;
-- Founder APIs use service-role access only after requireFounder(). No direct
-- client policies are added, so run state and controls stay behind Direct's
-- existing authenticated server boundary.
