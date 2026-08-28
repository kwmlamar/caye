-- 2026-08-28 — Pin Caye Direct threads
--
-- The sidebar's per-thread "more" menu (Rename/Pin/Archive/Delete, ChatGPT-
-- style) needs somewhere to record pin state. A single nullable timestamp
-- doubles as both the boolean flag (pinned = pinned_at is not null) and the
-- sort key for the Pinned section (most-recently-pinned first), so no
-- separate boolean + ordering column is needed.
alter table public.caye_direct_threads
  add column if not exists pinned_at timestamptz;

create index if not exists caye_direct_threads_pinned_idx
  on public.caye_direct_threads(workspace_id, status, pinned_at desc)
  where pinned_at is not null;
