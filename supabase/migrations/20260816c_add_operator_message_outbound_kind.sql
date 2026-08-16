-- 2026-08-16 — extend caye_outbound_queue.kind CHECK for send_operator_message
--
-- send_operator_message (lib/caye-agent/tools/write-low/send-operator-message.ts)
-- inserts a caye_outbound_queue row directly (not via enqueueOutbound) purely
-- to claim the idempotency_key UNIQUE constraint before a synchronous WhatsApp
-- dispatch. The insert still runs against this CHECK constraint, so the new
-- kind has to be listed here — same drift class db-enum-literals.test.ts and
-- lib/outbound-kind-migration-sync.test.ts exist to catch (see
-- 20260812_fix_outbound_kind_check.sql). Keep the database CHECK aligned with
-- lib/whatsapp/outbound.ts's OutboundKind union.
alter table public.caye_outbound_queue
  drop constraint if exists caye_outbound_queue_kind_check;

alter table public.caye_outbound_queue
  add constraint caye_outbound_queue_kind_check
  check (kind = any (array[
    'urgent_hold',
    'booking_created',
    'auth_failure',
    'morning_digest',
    'welcome',
    'otp',
    'ack',
    'escalation',
    'escalation_followup',
    'opportunity_scan',
    'business_insights',
    'operator_reminder',
    'dropped_confirmation',
    'reply_review',
    'payment_setup_needed',
    'operator_message'
  ]::text[]));
