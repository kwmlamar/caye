-- Keep caye_outbound_queue.kind aligned with the canonical OutboundKind
-- union. payment_setup_needed is deliberately schema/type-only until the
-- payment-request workflow has a real enqueue site and delivery copy.
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
    'payment_setup_needed'
  ]::text[]));
