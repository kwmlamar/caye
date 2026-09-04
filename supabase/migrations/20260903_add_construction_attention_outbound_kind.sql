-- 2026-09-03 — extend caye_outbound_queue.kind CHECK for construction attention
--
-- The construction ledger loop (lib/construction-ledger-cycle.ts) has raised
-- attention items since it shipped, and nothing has ever delivered them. The
-- receivables sweep in particular computes the whole "Friday ask" — which
-- invoices are outstanding, how long, whether a payment was ever confirmed —
-- writes it to caye_owner_attention, and stops there. Correct detection
-- reported into a place nobody opens is the exact failure the ODS audit found
-- in the business, so leaving the last hop unbuilt reproduces it in software.
--
-- lib/attention-delivery.ts is that hop, and this is the kind its rows carry.
-- One kind for construction attention rather than one per domain: the routing
-- table (lib/attention-routing.ts) already discriminates receivable from
-- payroll from purchase order, and the body composer reads the specifics off
-- the payload — the same shape 'escalation' uses. A kind per domain would be
-- a parallel path carrying no extra information.
--
-- Keep this aligned with lib/whatsapp/outbound.ts's OutboundKind union. That
-- alignment is asserted live, from both sources, by
-- lib/outbound-kind-migration-sync.test.ts — this constraint has drifted from
-- the union at least three times (2026-06-26, 2026-08-05, 2026-08-11/12), and
-- 'booking_created' was silently rejected by the database for two and a half
-- months because of it. Follow the drop+add full-redefinition pattern every
-- previous migration here uses; the sync test reads only the newest file and
-- an incremental patch would leave it reading a stale definition.
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
    'operator_message',
    'construction_attention'
  ]::text[]));
