-- Sales demo mode: let a cold prospect text Caye's platform WhatsApp
-- number and get a live front-desk-persona back-and-forth, seeded with
-- their own business's public tour info, with zero Meta account
-- connection. Distinct from the real cold-start signup flow on the
-- same webhook (app/api/webhooks/whatsapp-operator/route.ts) — a
-- demo_prospects hit is checked BEFORE tryColdStartWorkspace, so a
-- pre-registered demo number never falls into onboarding discovery.
--
-- Each row maps a real prospect's phone to a disposable demo
-- workspace (a normal `customers` row, plan='demo') pre-seeded with a
-- hand-written system prompt built from their own site/listings —
-- founder adds the row manually per prospect (no self-serve demo
-- signup; this is a founder-led sales tool, not a product surface).
create table public.demo_prospects (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  demo_workspace_id uuid not null references public.customers(id) on delete cascade,
  label text,
  created_at timestamptz not null default now()
);

comment on table public.demo_prospects is
  'Founder-added phone -> disposable demo workspace mapping. Checked in the whatsapp-operator webhook before tryColdStartWorkspace so a pre-registered prospect gets a live front-desk demo instead of real onboarding.';
