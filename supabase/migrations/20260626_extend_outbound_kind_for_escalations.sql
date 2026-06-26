-- 2026-06-26 — extend caye_outbound_queue.kind CHECK to include escalation kinds
--
-- Bug surfaced in live #50 test: enqueueOutbound failed with
-- "violates check constraint caye_outbound_queue_kind_check" because the
-- TypeScript OutboundKind type was extended in #50 to add 'escalation' and
-- 'escalation_followup', but the SQL CHECK on the kind column was never
-- updated to match. Every escalation ping queued by the front-desk path
-- was dying at the constraint, so no operator pings ever delivered.
--
-- Idempotent: drop-if-exists + re-add the constraint with the full enum.

alter table public.caye_outbound_queue
  drop constraint if exists caye_outbound_queue_kind_check;

alter table public.caye_outbound_queue
  add constraint caye_outbound_queue_kind_check
  check (kind in (
    'urgent_hold', 'same_day_booking', 'auth_failure',
    'morning_digest', 'welcome', 'otp', 'ack',
    'escalation', 'escalation_followup'
  ));
