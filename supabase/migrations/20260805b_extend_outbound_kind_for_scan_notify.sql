-- 2026-08-05 — extend caye_outbound_queue.kind CHECK to include the scan
-- crons' window-closed notify-only kinds.
--
-- opportunity-scan and business-insights now enqueue a short
-- caye_urgent_hold-shaped template ping when the operator's 24h WhatsApp
-- window is closed, instead of only logging a not_sent row (P5 in
-- briefs/whatsapp-delivery-reliability.md). Same bug class as
-- 20260626_extend_outbound_kind_for_escalations.sql: the TypeScript
-- OutboundKind type gets extended in the same commit as this migration, but
-- the DB CHECK has to be updated too or enqueueOutbound fails outright.
--
-- Idempotent: drop-if-exists + re-add the constraint with the full enum.

alter table public.caye_outbound_queue
  drop constraint if exists caye_outbound_queue_kind_check;

alter table public.caye_outbound_queue
  add constraint caye_outbound_queue_kind_check
  check (kind in (
    'urgent_hold', 'same_day_booking', 'auth_failure',
    'morning_digest', 'welcome', 'otp', 'ack',
    'escalation', 'escalation_followup',
    'opportunity_scan', 'business_insights'
  ));
