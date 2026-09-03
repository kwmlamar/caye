-- outreach-tried-signal-integrity (2026-09-03): outreach_leads.tried_at
-- currently conflates two very different facts — "a hit landed on the
-- tracked demo link" and "a real demo conversation happened" — and, as of
-- this migration, the former was mostly mail security scanners, not
-- people (production evidence: 16 leads marked tried, 0 rows in
-- demo_session_messages that trace back to a cold-outreach lead, 9/16
-- stamped the same day as send).
--
-- app/api/r/[token]/route.ts now gates tried_at/demo_link_clicked behind a
-- bot classifier (lib/outreach-click-classifier.ts) instead of stamping
-- on every GET, which fixes the false-positive problem going forward.
-- tried_at still only means "a plausibly-human click", though — it is not
-- proof a demo conversation actually happened. This column is the
-- stronger, separate fact: set only once an inbound WhatsApp message can
-- be attributed back to this specific lead (see lib/outreach-click-demo-
-- confirmation.ts for the matching helper — not wired to any inbound path
-- yet, since app/api/webhooks/whatsapp-operator/route.ts is out of scope
-- for this change; see that file's module comment and the accompanying
-- PR description for exactly what the webhook-side change would need).
alter table public.outreach_leads
  add column demo_confirmed_at timestamptz,
  add column demo_confirmed_phone text;

comment on column public.outreach_leads.demo_confirmed_at is
  'Set only when an inbound WhatsApp message has been positively matched back to this lead (not yet wired to any inbound path — see lib/outreach-click-demo-confirmation.ts). Distinct from tried_at, which means only "a plausibly-human hit on the tracked link", not "a demo conversation happened". Never set by app/api/r/[token]/route.ts itself — that route only ever sees an outbound HTTP redirect, never the WhatsApp side.';

comment on column public.outreach_leads.demo_confirmed_phone is
  'The WhatsApp phone number the confirming inbound message arrived from, captured alongside demo_confirmed_at for audit/debugging. Not used for lead identity or matching — outreach_leads is keyed by lead_email, not phone (see 20260721c_outreach_leads.sql).';
