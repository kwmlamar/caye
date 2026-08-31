-- Durable autonomous lifecycle for canonical research_questions.
-- This extends the existing research runtime instead of creating a parallel
-- investigations table or scheduler.

alter table public.research_questions
  add column if not exists investigation_mode text not null default 'one_shot'
    check (investigation_mode in ('one_shot', 'follow_until_resolved', 'monitor')),
  add column if not exists lifecycle_status text not null default 'active'
    check (lifecycle_status in ('active', 'resolved', 'paused')),
  add column if not exists priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  add column if not exists next_review_at timestamptz,
  add column if not exists refresh_interval_hours integer
    check (refresh_interval_hours is null or refresh_interval_hours between 1 and 720),
  add column if not exists autonomous_run_count integer not null default 0
    check (autonomous_run_count >= 0),
  add column if not exists max_autonomous_runs integer not null default 8
    check (max_autonomous_runs between 1 and 100),
  add column if not exists no_change_streak integer not null default 0
    check (no_change_streak >= 0),
  add column if not exists last_run_at timestamptz,
  add column if not exists last_material_change_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution_reason text;

create index if not exists research_questions_due_investigation_idx
  on public.research_questions (next_review_at, priority)
  where lifecycle_status = 'active'
    and next_review_at is not null
    and status <> 'archived';

comment on column public.research_questions.investigation_mode is
  'one_shot stops after one evidence-backed run; follow_until_resolved revisits unresolved/contradictory evidence; monitor continues periodic re-checks with backoff.';
comment on column public.research_questions.next_review_at is
  'When the existing research worker should make this canonical question eligible for another run. NULL means no autonomous wake-up is scheduled.';
comment on column public.research_questions.max_autonomous_runs is
  'Hard lifetime autonomy budget for this investigation before it pauses instead of recursively researching forever.';
comment on column public.research_questions.lifecycle_status is
  'Autonomous investigation state independent of the legacy open/archived question visibility status.';
