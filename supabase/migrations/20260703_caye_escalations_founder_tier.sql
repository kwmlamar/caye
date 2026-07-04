-- 2026-07-03 — founder-tier escalation follow-up
--
-- Escalations routed to 'owner' only can now also loop in the founder once
-- they've sat unresolved past a threshold, so an operator's indecision
-- (confirmed pattern, not just slow response time) doesn't leave a
-- customer's held reply stuck indefinitely. See
-- app/api/caye/escalation-followup/cron/route.ts.
--
-- Set once, the first time the founder tier fires for a given escalation,
-- so it doesn't re-fire on every subsequent cron pass.

alter table public.caye_escalations
  add column if not exists founder_escalated_at timestamptz;
