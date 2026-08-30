-- Compatibility overload: existing application/tests call write_business_fact_atomic.
-- Extra typed-memory arguments select this overload; the original 9-argument
-- function remains untouched for older writers. The typed implementation still
-- owns authority checks, workspace-bound references and the transaction.
create or replace function public.write_business_fact_atomic(
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
language sql security definer set search_path = public as $$
  select * from public.write_typed_business_memory_atomic(
    p_workspace_id,
    p_category,
    p_fact,
    p_source,
    p_created_by,
    p_service_id,
    p_canonical_key,
    p_expires_at,
    p_supersede_id,
    p_memory_type,
    p_subject_type,
    p_subject_id,
    p_knowledge_mode,
    p_confidence,
    p_valid_from,
    p_sensitivity,
    p_authority_kind,
    p_provenance,
    p_contradicts_fact_id,
    p_correction_of_fact_id
  );
$$;

revoke all on function public.write_business_fact_atomic(uuid,text,text,text,text,uuid,text,timestamptz,uuid,text,text,text,text,numeric,timestamptz,text,text,jsonb,uuid,uuid) from public, anon, authenticated;
grant execute on function public.write_business_fact_atomic(uuid,text,text,text,text,uuid,text,timestamptz,uuid,text,text,text,text,numeric,timestamptz,text,text,jsonb,uuid,uuid) to service_role;
