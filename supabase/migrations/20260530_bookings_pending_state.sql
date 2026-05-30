-- 2026-05-30 — Allow bookings to exist in a 'pending' (tentative) state
-- before a time is confirmed.
--
-- BACKGROUND: The email sync route was writing booking rows with
-- status='confirmed' the moment Caye sent an availability-check email,
-- before the customer had agreed to anything. The Stallings 2026-05-29
-- case surfaced this: a confirmed booking with an invented 09:00 time
-- and a null conversation_id. See Clients/bimini-island-tours.md.
--
-- FIX: change the auto-write to status='pending' (= tentative,
-- awaiting customer confirmation). Time may not be known yet at that
-- point — the customer might propose a different start. Loosen the
-- NOT NULL constraint on booking_time so tentative rows can exist
-- without an invented time.
--
-- The TypeScript Booking type already declares booking_time as
-- `string | null` — this aligns the DB to the type contract.

ALTER TABLE bookings
  ALTER COLUMN booking_time DROP NOT NULL;

COMMENT ON COLUMN bookings.booking_time IS
  'HH:MM:SS or NULL. NULL is allowed for status=''pending'' rows where the time has not yet been confirmed with the customer.';
