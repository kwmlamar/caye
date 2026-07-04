-- 2026-07-03 — payment confirmation + tour reminder idempotency
--
-- Two new guest-facing capabilities need columns on `bookings`:
--
-- 1. `send_payment_confirmation` (back-office tool): operator says
--    "<name> paid" in WhatsApp, Caye sends the customer a payment
--    confirmation. payment_confirmed_at records when this fired, both
--    as an audit trail and so the same booking can't be double-confirmed.
--    There is no general payment_status column (Bimini's real rails —
--    cash/Zelle/card — have no receipt to detect), so this is
--    operator-attested, not system-verified.
--
-- 2. Day-before / day-of tour reminder cron: two one-shot markers so a
--    booking can't get double-reminded across cron runs.

alter table public.bookings
  add column if not exists payment_confirmed_at timestamptz,
  add column if not exists day_before_reminder_sent_at timestamptz,
  add column if not exists day_of_reminder_sent_at timestamptz;
