-- Persistent operating-memory follow-up hardening.
--
-- business_facts is an internal durable-memory substrate. Runtime access goes
-- through service-role server code and the service-role-only memory RPCs. RLS
-- currently has no client policies, so keeping broad anon/authenticated table
-- grants adds unnecessary blast radius if a policy is ever introduced or
-- changed later.

revoke all on table public.business_facts from anon, authenticated;
grant all on table public.business_facts to service_role;

-- Cover self-referential lineage FKs. These matter for correction,
-- contradiction and supersession maintenance as durable memory grows.
create index if not exists business_facts_superseded_by_idx
  on public.business_facts (superseded_by)
  where superseded_by is not null;

create index if not exists business_facts_contradicts_fact_id_idx
  on public.business_facts (contradicts_fact_id)
  where contradicts_fact_id is not null;

create index if not exists business_facts_correction_of_fact_id_idx
  on public.business_facts (correction_of_fact_id)
  where correction_of_fact_id is not null;

-- The existing (workspace_id, service_id) partial index is optimized for
-- workspace-scoped retrieval, but does not cover the service_id FK itself
-- because service_id is not the leading column.
create index if not exists business_facts_service_id_fk_idx
  on public.business_facts (service_id)
  where service_id is not null;
