-- 2026-06-25 — service visibility (#52)
--
-- `visibility = 'public' | 'private'` on booking_services. Public is the
-- default — Caye lists the service when a guest asks "what tours do you
-- have?". Private services are kept out of the proactive list (per the
-- South Bimini / Ponce de León pattern in memory project_bimini_south_tour_quiet)
-- but Caye still quotes and books them when a guest names them directly.
--
-- Set via the back-office set_service_visibility tool (#52).

alter table public.booking_services
  add column if not exists visibility text not null default 'public'
    check (visibility in ('public', 'private'));

comment on column public.booking_services.visibility is
  'public = surface in proactive "what tours do you have?" listings. private = honor when named by guest but never proactively suggest.';
