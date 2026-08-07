-- 2026-08-07 — enable RLS on the nine service-role-only tables
--
-- These nine tables shipped with Row Level Security disabled, which means
-- anyone holding the publishable anon key could read or write every row
-- directly, bypassing the app entirely. The exposure was not theoretical:
-- caye_operator_messages is the full back-office transcript between Caye and
-- every workspace owner, outreach_leads is TropiTech's own cold-outreach list
-- with prospect emails, and caye_outbound_queue holds messages staged for
-- real customers. All of that was world-readable to anyone who pulled the
-- anon key out of a browser bundle.
--
-- WHY NO POLICIES ARE ADDED
-- Every code path that touches these tables goes through createServiceClient
-- (lib/supabase-server.ts), which authenticates with SUPABASE_SERVICE_ROLE_KEY.
-- The service role bypasses RLS by design, so enabling RLS without policies
-- leaves all legitimate access working while dropping anon/authenticated
-- access to zero. Verified before writing this: all references live in
-- app/api/** route handlers and server-only lib/** modules, and none of them
-- construct a browser or anon client. app_configuration, outreach_scripts and
-- admin_settings have no code references at all.
--
-- Deliberately a deny-by-default posture: if a future client-side feature
-- needs one of these tables, it should fail loudly and get an explicit,
-- reviewed policy rather than inherit blanket anon access.
--
-- Reversible: alter table ... disable row level security.

alter table public.app_configuration        enable row level security;
alter table public.outreach_scripts         enable row level security;
alter table public.admin_settings           enable row level security;
alter table public.caye_outbound_queue      enable row level security;
alter table public.whatsapp_templates       enable row level security;
alter table public.caye_operator_messages   enable row level security;
alter table public.demo_prospects           enable row level security;
alter table public.outreach_leads           enable row level security;
alter table public.caye_founder_alert_log   enable row level security;
