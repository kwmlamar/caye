-- 2026-07-26 — payment-link send scaffold (ChargeAnywhere)
--
-- Companion to 20260703b's payment_confirmed_at (operator-attested "X
-- paid"). These three columns track the OTHER side: Caye generating and
-- sending a ChargeAnywhere payment link herself via send_payment_link,
-- instead of Karenda creating it manually in ChargeAnywhere.
--
-- payment_link_sent_at also doubles as the "don't send a second link"
-- guard, same pattern as payment_confirmed_at.

alter table public.bookings
  add column if not exists payment_link_sent_at timestamptz,
  add column if not exists payment_link_url text,
  add column if not exists payment_link_invoice_number text;
