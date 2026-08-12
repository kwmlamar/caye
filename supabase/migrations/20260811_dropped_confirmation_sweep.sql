-- Track which dead staged actions the operator has already been told about.
--
-- 2026-08-11: Mrs. Max answered "yes" to a staged send to Valencia Wills and
-- the turn vanished — no model call, no send, no error. The row expired 14
-- minutes later and nothing anywhere noticed. She believed it had gone out.
--
-- /api/caye/dropped-confirmation-sweep now finds these. This column is what
-- stops it telling her the same thing every time it runs.
alter table caye_pending_actions
  add column if not exists dropped_reported_at timestamptz;

comment on column caye_pending_actions.dropped_reported_at is
  'Set when the operator was pinged that this staged action expired without executing. Null means unreported, not undropped.';

-- The sweep asks for live-but-dead rows across all workspaces every few
-- minutes; without this it is a full scan of a table that only grows.
create index if not exists caye_pending_actions_dropped_sweep_idx
  on caye_pending_actions (expires_at)
  where executed_at is null
    and cancelled_at is null
    and dropped_reported_at is null;
