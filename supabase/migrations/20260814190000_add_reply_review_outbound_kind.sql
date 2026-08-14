-- A sent-but-uncertain answer is a review notification, not an escalation.
-- Keep the database CHECK aligned with lib/whatsapp/outbound.ts.
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
    'payment_setup_needed'
  ]::text[]));
