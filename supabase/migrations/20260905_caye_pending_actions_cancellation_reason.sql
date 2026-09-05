-- Payment watcher (propose-only): a staged proposal must be explicitly
-- rejectable with a reason, not just left to expire silently or be
-- superseded by a newer draft. caye_pending_actions already has
-- cancelled_at (set today only by the internal supersession path in
-- gateHighRisk), but nothing records WHY a human declined one. Without
-- this, a rejected payment-watcher proposal is indistinguishable later
-- from one nobody ever looked at.
alter table public.caye_pending_actions
  add column if not exists cancellation_reason text;
