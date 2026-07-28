-- customers.status has drifted from the app's CustomerStatus type
-- ('active' | 'inactive' | 'suspended' | 'trial', types/database.ts:3,
-- consumed by STATUS_LABEL/STATUS_COLOR in
-- components/dashboard/founder-home/FounderHome.tsx) since whenever this
-- constraint was first written with 'cancelled' instead of 'inactive'.
-- Confirmed 'cancelled' is never used for customers.status anywhere in the
-- app (every hit is the unrelated bookings.status enum) — safe to swap.
alter table customers drop constraint customers_status_check;
alter table customers add constraint customers_status_check
  check (status = any (array['trial'::text, 'active'::text, 'suspended'::text, 'inactive'::text]));
