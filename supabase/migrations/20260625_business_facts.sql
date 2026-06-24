-- 2026-06-25 — business_facts (#51)
--
-- The coarse escape hatch for unstructured business knowledge. Anything
-- that doesn't fit a discrete schema (policies, special handling, logistics
-- quirks, service details Caye should know but isn't worth a structured
-- column) lands here.
--
-- Two tools (add_business_fact, query_business_knowledge) plus a hook in
-- the front-desk reply path that fetches the workspace's facts before
-- generating the reply. Facts are workspace-scoped and category-tagged so
-- a future promotion-loop can see which categories accumulate and graduate
-- them into fine-grained tools (e.g. >=3 'policy' facts about cancellation
-- → consider a structured cancellation-policy field).

create table if not exists public.business_facts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  category text not null check (category in ('policy', 'service_detail', 'special_handling', 'logistics')),
  fact text not null,
  -- 'owner-direct' = owner taught Caye via add_business_fact in WhatsApp.
  -- 'escalation-capture' = future hook (#50 spec) where Caye auto-captures
  -- the owner's response to a knowledge-category escalation.
  source text not null default 'owner-direct' check (source in ('owner-direct', 'escalation-capture')),
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists business_facts_workspace_idx
  on public.business_facts (workspace_id);

create index if not exists business_facts_workspace_category_idx
  on public.business_facts (workspace_id, category);

alter table public.business_facts enable row level security;
