-- WhatsApp-first cold-start signup (lib/onboarding-whatsapp.ts:tryColdStartWorkspace)
-- inserts a new customers row with business_name/contact_email unset —
-- Caye fills them in via the discovery-grill turns that follow. The
-- columns were still NOT NULL, so every cold-start insert threw and the
-- sender silently fell through to the "couldn't find your account"
-- fallback. Deploy the FounderHome.tsx / global-performance null-guards
-- (same change set) before applying this — otherwise a cold-start
-- workspace with a null business_name can land while the dashboard code
-- still assumes non-null and crashes rendering it.

alter table public.customers
  alter column business_name drop not null,
  alter column contact_email drop not null;
