-- 2026-07-05 — all three driver dispatch templates cleared Meta review
-- (status: Active - Quality pending, same as the other live templates).
-- Flipping local registry to match so the driver-dispatch code path
-- reflects reality.

update public.whatsapp_templates
set status = 'approved', last_synced_at = now()
where name in ('caye_driver_consent', 'caye_driver_dispatch', 'caye_driver_reminder');
