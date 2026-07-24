-- 2026-07-23 — caye_team_consent cleared Meta review (status: Active -
-- Quality pending, same as the other live templates). Flipping local
-- registry to match so add_team_member's fallback stops using the numeric
-- caye_otp code for owner/staff and uses the real consent flow.

update public.whatsapp_templates
set status = 'approved', last_synced_at = now()
where name = 'caye_team_consent';
