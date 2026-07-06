-- 2026-07-05 — driver dispatch (Karenda request, grilled same-day)
--
-- Karenda: "will Caye be able to send messages to our driver" (dispatch
-- with pickup time/location/guide/itinerary) + "send a reminder to the
-- drivers ... like an hour before". Neither concept existed: no driver
-- identity, no booking→driver assignment, no reminder cadence finer than
-- daily.
--
-- Design (grilled 2026-07-05):
-- - Drivers reuse operator_allowlist (new role 'driver') and the existing
--   pending-verification columns, but with a fixed "OK" consent reply
--   instead of a random OTP (a stranger who mis-receives either message
--   can just as easily echo back a 6-digit code as type "OK" — the code
--   isn't protecting anything a friendlier consent ask doesn't already).
-- - Drivers get a narrow, real agent mode: can answer from their assigned
--   booking's literal fields + logistics-category business_facts only;
--   anything else escalates to the owner. Zero write-tool access.
-- - booking_driver_assignments resolves "which booking is this driver
--   asking about" and carries the one-shot reminder marker.

alter table public.operator_allowlist
  drop constraint if exists operator_allowlist_role_check;

alter table public.operator_allowlist
  add constraint operator_allowlist_role_check
  check (role in ('owner', 'staff', 'founder', 'driver'));

create table if not exists public.booking_driver_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  driver_phone text not null,
  driver_name text,
  assigned_at timestamptz not null default now(),
  driver_reminder_sent_at timestamptz,
  unique (booking_id, driver_phone)
);

create index if not exists booking_driver_assignments_workspace_idx
  on public.booking_driver_assignments (workspace_id);

create index if not exists booking_driver_assignments_driver_phone_idx
  on public.booking_driver_assignments (driver_phone);

-- Reminder cron scans for bookings ~1h out with no reminder sent yet.
create index if not exists booking_driver_assignments_reminder_pending_idx
  on public.booking_driver_assignments (booking_id)
  where driver_reminder_sent_at is null;

alter table public.booking_driver_assignments enable row level security;

-- Local registry entries (status='pending' until submitted + approved in
-- Meta Business Manager — same pattern as the five templates seeded
-- 2026-05-28). Placeholder counts match the deterministic-fields-only
-- design: Caye never recomposes these from an LLM call, so the template
-- body IS the full message modulo the variables below.
insert into public.whatsapp_templates (name, category, body_template, placeholder_count, status)
values
  (
    'caye_driver_consent',
    'utility',
    'Hi {{1}} — it''s Caye, {{2}}''s AI assistant. {{2}} added you so I can reach out about tour pickups. Reply OK and I''ll have you set up.',
    2,
    'pending'
  ),
  (
    'caye_driver_dispatch',
    'utility',
    'New pickup for you, {{1}}:\n\nGuest: {{2}}\nTour: {{3}}\nPickup time: {{4}}\nPickup location: {{5}}\nGuests: {{6}}\n\nQuestions? Just reply here.',
    6,
    'pending'
  ),
  (
    'caye_driver_reminder',
    'utility',
    'Reminder {{1}} — {{2}}''s pickup is in about an hour, {{3}} at {{4}}.',
    4,
    'pending'
  )
on conflict (name) do nothing;
