-- 2026-07-08 — auto-expire escalations whose target date has passed
--
-- The daily escalation-followup cron (app/api/caye/escalation-followup/cron/
-- route.ts) had no concept of "the underlying event date already happened" —
-- it only checked whether the operator had replied. Confirmed live: Riley
-- Dungan's July 4th booking window kept getting a daily "still waiting"
-- nudge days after July 4th had already passed, because nothing ever told
-- the cron the date was dead.
--
-- target_date is a best-effort extraction (lib/whatsapp/urgency.ts,
-- extractTargetDate) of a concrete calendar date mentioned in the
-- escalation's internal_context/customer_facing_message at creation time.
-- Null when no date was mentioned or found.
--
-- expired_at is set once the cron observes target_date has passed with no
-- operator response — sends one final closing note, then stops nudging.
-- Distinct from owner_responded_at (operator explicitly resolved it).

alter table public.caye_escalations
  add column if not exists target_date date,
  add column if not exists expired_at timestamptz;
