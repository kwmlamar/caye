create table if not exists public.caye_cron_run_history (
  id bigint generated always as identity primary key,
  cron_name text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  status text not null check (status in ('ok', 'error')),
  summary jsonb,
  error text,
  duration_ms integer not null,
  created_at timestamptz not null default now()
);
create index if not exists caye_cron_run_history_name_started_idx on public.caye_cron_run_history (cron_name, started_at desc);
alter table public.caye_cron_run_history enable row level security;
comment on table public.caye_cron_run_history is 'Server-only append-only cron execution history used for authoritative operational explanations.';
