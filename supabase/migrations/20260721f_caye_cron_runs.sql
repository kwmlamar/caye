-- Admin Shell (2026-07-21) — last-run-wins status for the cron jobs
-- exposed to the get_cron_health admin-shell tool. Written by
-- lib/cron-run-log.ts's recordCronRun(), wrapping each cron route's
-- extracted core logic — captures both scheduled runs (cron-job.org) and
-- founder-triggered manual runs (trigger_cron tool) identically.
--
-- Known limitation, not silently assumed solved: this is a single row per
-- cron name, overwritten each run — no history/audit trail. If a run
-- history is wanted later, that's an append-only log table instead.
create table if not exists public.caye_cron_runs (
  cron_name text primary key,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text check (last_status in ('ok', 'error')),
  last_summary jsonb,
  last_error text,
  last_duration_ms integer
);

alter table public.caye_cron_runs enable row level security;
