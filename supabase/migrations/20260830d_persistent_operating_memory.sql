-- Persistent operating memory, built on business_facts rather than beside it.
-- Existing business_facts remains the authoritative workspace-scoped durable
-- knowledge store. These columns make its semantics explicit and retrievable.

alter table public.business_facts
  add column if not exists memory_type text not null default 'fact',
  add column if not exists subject_type text not null default 'workspace',
  add column if not exists subject_id text,
  add column if not exists knowledge_mode text not null default 'explicit',
  add column if not exists confidence numeric not null default 1.0,
  add column if not exists valid_from timestamptz not null default now(),
  add column if not exists sensitivity text not null default 'workspace',
  add column if not exists authority_kind text not null default 'operator',
  add column if not exists provenance jsonb not null default '{}'::jsonb,
  add column if not exists contradicts_fact_id uuid references public.business_facts(id) on delete set null,
  add column if not exists correction_of_fact_id uuid references public.business_facts(id) on delete set null;

do $$ begin
  alter table public.business_facts add constraint business_facts_memory_type_check
    check (memory_type in ('fact','preference','procedure','policy','decision','correction','operating_pattern','outcome','assumption','prior_work'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.business_facts add constraint business_facts_subject_type_check
    check (subject_type in ('workspace','person','organization','property','project','system_asset','service','customer'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.business_facts add constraint business_facts_knowledge_mode_check
    check (knowledge_mode in ('explicit','observed','inferred','derived'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.business_facts add constraint business_facts_confidence_check
    check (confidence >= 0 and confidence <= 1);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.business_facts add constraint business_facts_sensitivity_check
    check (sensitivity in ('workspace','restricted','private'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.business_facts add constraint business_facts_authority_kind_check
    check (authority_kind in ('owner','founder','operator','system','external_source','inference'));
exception when duplicate_object then null; end $$;

create index if not exists business_facts_typed_retrieval_idx
  on public.business_facts (workspace_id, memory_type, subject_type, subject_id, created_at desc)
  where superseded_at is null;

-- Typed writer. This deliberately delegates supersession/concurrency to the
-- existing write_business_fact_atomic primitive and only enriches the row in
-- the same transaction. It also prevents low-authority inference from
-- silently replacing explicit human knowledge.
create or replace function public.write_typed_business_memory_atomic(
  p_workspace_id uuid,
  p_category text,
  p_fact text,
  p_source text,
  p_created_by text,
  p_service_id uuid default null,
  p_canonical_key text default null,
  p_expires_at timestamptz default null,
  p_supersede_id uuid default null,
  p_memory_type text default 'fact',
  p_subject_type text default 'workspace',
  p_subject_id text default null,
  p_knowledge_mode text default 'explicit',
  p_confidence numeric default 1.0,
  p_valid_from timestamptz default now(),
  p_sensitivity text default 'workspace',
  p_authority_kind text default 'operator',
  p_provenance jsonb default '{}'::jsonb,
  p_contradicts_fact_id uuid default null,
  p_correction_of_fact_id uuid default null
) returns table (id uuid, created_at timestamptz, superseded_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_existing public.business_facts%rowtype;
  v_result record;
begin
  -- Explicit target and canonical-chain target both receive the authority
  -- check. An inference may be stored as a candidate elsewhere, but it may
  -- never permanently erase explicit/observed operating knowledge.
  if p_supersede_id is not null then
    select * into v_existing from public.business_facts
      where business_facts.id = p_supersede_id
        and business_facts.workspace_id = p_workspace_id
      for update;
  elsif p_canonical_key is not null then
    select * into v_existing from public.business_facts
      where business_facts.workspace_id = p_workspace_id
        and business_facts.canonical_key = p_canonical_key
        and coalesce(business_facts.service_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(p_service_id, '00000000-0000-0000-0000-000000000000'::uuid)
        and business_facts.superseded_at is null
      for update;
  end if;

  if v_existing.id is not null
     and p_knowledge_mode in ('inferred','derived')
     and v_existing.knowledge_mode in ('explicit','observed') then
    raise exception 'inferred/derived memory cannot supersede explicit/observed memory %', v_existing.id
      using errcode = '42501';
  end if;

  select * into v_result from public.write_business_fact_atomic(
    p_workspace_id, p_category, p_fact, p_source, p_created_by,
    p_service_id, p_canonical_key, p_expires_at, p_supersede_id
  );

  update public.business_facts set
    memory_type = p_memory_type,
    subject_type = p_subject_type,
    subject_id = p_subject_id,
    knowledge_mode = p_knowledge_mode,
    confidence = p_confidence,
    valid_from = p_valid_from,
    sensitivity = p_sensitivity,
    authority_kind = p_authority_kind,
    provenance = coalesce(p_provenance, '{}'::jsonb),
    contradicts_fact_id = p_contradicts_fact_id,
    correction_of_fact_id = coalesce(p_correction_of_fact_id, v_result.superseded_id)
  where business_facts.id = v_result.id;

  return query select v_result.id, v_result.created_at, v_result.superseded_id;
end;
$$;

revoke all on function public.write_typed_business_memory_atomic(uuid,text,text,text,text,uuid,text,timestamptz,uuid,text,text,text,text,numeric,timestamptz,text,text,jsonb,uuid,uuid) from public, anon, authenticated;
grant execute on function public.write_typed_business_memory_atomic(uuid,text,text,text,text,uuid,text,timestamptz,uuid,text,text,text,text,numeric,timestamptz,text,text,jsonb,uuid,uuid) to service_role;

-- Retrieval is deterministic first, semantic second. Callers must supply the
-- workspace and an allowed sensitivity ceiling. Superseded, expired, and
-- not-yet-valid memories cannot leak back into behavior.
create or replace function public.retrieve_operating_memory(
  p_workspace_id uuid,
  p_query text default null,
  p_memory_types text[] default null,
  p_subject_type text default null,
  p_subject_id text default null,
  p_include_restricted boolean default false,
  p_limit integer default 30
) returns table (
  id uuid, memory_type text, subject_type text, subject_id text,
  category text, fact text, canonical_key text, confidence numeric,
  knowledge_mode text, authority_kind text, source text, provenance jsonb,
  valid_from timestamptz, valid_until timestamptz, created_at timestamptz,
  relevance integer
)
language sql stable security definer set search_path = public as $$
  select f.id, f.memory_type, f.subject_type, f.subject_id,
         f.category, f.fact, f.canonical_key, f.confidence,
         f.knowledge_mode, f.authority_kind, f.source, f.provenance,
         f.valid_from, f.expires_at, f.created_at,
         (case when p_query is null or btrim(p_query) = '' then 0 else
           (case when lower(coalesce(f.canonical_key,'')) = lower(p_query) then 8 else 0 end) +
           (case when lower(f.fact) like '%' || lower(p_query) || '%' then 4 else 0 end) +
           (case when lower(f.category) like '%' || lower(p_query) || '%' then 2 else 0 end)
         end)::integer as relevance
  from public.business_facts f
  where f.workspace_id = p_workspace_id
    and f.superseded_at is null
    and f.valid_from <= now()
    and (f.expires_at is null or f.expires_at > now())
    and (p_memory_types is null or f.memory_type = any(p_memory_types))
    and (p_subject_type is null or f.subject_type = p_subject_type)
    and (p_subject_id is null or f.subject_id = p_subject_id)
    and (p_include_restricted or f.sensitivity = 'workspace')
  order by relevance desc, f.confidence desc,
           case f.knowledge_mode when 'explicit' then 4 when 'observed' then 3 when 'derived' then 2 else 1 end desc,
           f.created_at desc
  limit greatest(1, least(coalesce(p_limit,30),100));
$$;

revoke all on function public.retrieve_operating_memory(uuid,text,text[],text,text,boolean,integer) from public, anon, authenticated;
grant execute on function public.retrieve_operating_memory(uuid,text,text[],text,text,boolean,integer) to service_role;

-- Evidence surface for Direction. It is intentionally aggregate-only: the
-- Direction UI can prove that Memory & Context is operating without exposing
-- sensitive memory content.
create or replace view public.caye_memory_capability_evidence as
select
  f.workspace_id,
  count(*) filter (where f.superseded_at is null and (f.expires_at is null or f.expires_at > now())) as active_memories,
  count(distinct f.memory_type) filter (where f.superseded_at is null) as active_memory_types,
  count(*) filter (where f.correction_of_fact_id is not null) as correction_chain_links,
  count(*) filter (where f.provenance <> '{}'::jsonb) as memories_with_provenance,
  max(f.created_at) as latest_memory_at,
  (select count(*) from public.operator_learning_audit a where a.workspace_id = f.workspace_id and a.decision in ('written','superseded_and_written')) as audited_learning_writes
from public.business_facts f
group by f.workspace_id;

comment on view public.caye_memory_capability_evidence is
  'Aggregate evidence for the Direction Memory & Context capability; no memory content is exposed.';
