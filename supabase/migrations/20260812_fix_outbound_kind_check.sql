-- Three kinds the TS OutboundKind union has allowed for a while, that the
-- database's CHECK constraint never matched — so every insert of these kinds
-- has been silently rejected since the day each shipped:
--
--   'booking_created'    — the DB said 'same_day_booking' since the very
--                           first outbound migration (2026-05-28). Renamed
--                           at some point in code, never in the schema.
--                           Zero rows of either kind have ever existed.
--                           enqueueBookingCreated has never once notified an
--                           operator of a new booking over WhatsApp.
--   'operator_reminder'  — added in code 2026-08-09 (schedule_reminder),
--                           never added here. Zero rows exist; every
--                           reminder Caye has offered to set has failed.
--   'dropped_confirmation' — added in code 2026-08-11, same story, just
--                           caught before it ever fired live (found while
--                           testing the sweep itself).
--
-- Found trying to enqueue an ordinary operator ping and hitting
-- caye_outbound_queue_kind_check — the third instance of this exact bug
-- class in one day (see add_internal_note's sender_type enum, 2026-08-11).
-- lib/db-enum-literals.test.ts guards Postgres enum columns; it cannot see
-- an inline CHECK constraint like this one, which is why this slipped past.
alter table caye_outbound_queue drop constraint caye_outbound_queue_kind_check;

alter table caye_outbound_queue add constraint caye_outbound_queue_kind_check
  check (kind = any (array[
    'urgent_hold', 'booking_created', 'auth_failure', 'morning_digest',
    'welcome', 'otp', 'ack', 'escalation', 'escalation_followup',
    'opportunity_scan', 'business_insights', 'operator_reminder',
    'dropped_confirmation'
  ]::text[]));
