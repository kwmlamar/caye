-- Persist reusable engineering lessons only after evidence-backed conclusive verdicts.
-- Domain tables remain authoritative; business_facts stores a derived, scoped summary.

create or replace function public.capture_engineering_verdict_learning()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_property_id uuid;
  v_prior_memory_id uuid;
  v_confidence numeric;
begin
  if new.verdict = 'inconclusive' then return new; end if;

  if not exists (select 1 from public.engineering_project_execution_evidence e where e.workspace_id = new.workspace_id and e.project_id = new.project_id)
     or not exists (select 1 from public.engineering_project_outcomes o where o.workspace_id = new.workspace_id and o.project_id = new.project_id) then return new; end if;

  select p.property_id into v_property_id from public.engineering_projects p where p.workspace_id = new.workspace_id and p.id = new.project_id;
  if v_property_id is null then raise exception 'Engineering verdict project scope could not be resolved'; end if;

  select f.id into v_prior_memory_id from public.business_facts f where f.workspace_id = new.workspace_id and f.canonical_key = 'engineering_outcome:project:' || new.project_id::text and f.subject_type = 'property' and f.subject_id = v_property_id::text and f.memory_type = 'outcome' and f.knowledge_mode = 'derived' and f.authority_kind = 'system' and f.superseded_at is null order by f.created_at desc limit 1;

  v_confidence := case new.verdict when 'succeeded' then 0.95 when 'failed' then 0.95 when 'partially_succeeded' then 0.85 else 0.80 end;

  perform public.write_typed_business_memory_atomic(p_workspace_id := new.workspace_id,p_category := 'service_detail',p_fact := format('Engineering project %s verdict: %s. %s', new.project_id, new.verdict, new.summary),p_source := 'system-derived',p_created_by := 'engineering_verdict_learning_v1',p_service_id := null,p_canonical_key := 'engineering_outcome:project:' || new.project_id::text,p_expires_at := null,p_supersede_id := v_prior_memory_id,p_memory_type := 'outcome',p_subject_type := 'property',p_subject_id := v_property_id::text,p_knowledge_mode := 'derived',p_confidence := v_confidence,p_valid_from := new.created_at,p_sensitivity := 'workspace',p_authority_kind := 'system',p_provenance := jsonb_build_object('kind','engineering_project_verdict','project_id',new.project_id,'property_id',v_property_id,'verdict_id',new.id,'verdict',new.verdict,'reason_codes',new.reason_codes,'source_message_id',new.source_message_id,'execution_evidence_required',true,'outcome_evidence_required',true),p_contradicts_fact_id := null,p_correction_of_fact_id := null);
  return new;
end;
$$;

revoke all on function public.capture_engineering_verdict_learning() from public, anon, authenticated;
grant execute on function public.capture_engineering_verdict_learning() to service_role;
drop trigger if exists engineering_verdict_learning_after_insert on public.engineering_project_verdicts;
create trigger engineering_verdict_learning_after_insert after insert on public.engineering_project_verdicts for each row execute function public.capture_engineering_verdict_learning();

create or replace function public.retrieve_engineering_outcome_memory(p_workspace_id uuid,p_property_id uuid,p_limit integer default 20)
returns table (id uuid,fact text,confidence numeric,provenance jsonb,created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id,m.fact,m.confidence,m.provenance,m.created_at from public.retrieve_operating_memory(p_workspace_id,null,array['outcome']::text[],'property',p_property_id::text,false,least(greatest(coalesce(p_limit,20),1),100)) m where m.memory_type='outcome' and m.subject_type='property' and m.subject_id=p_property_id::text order by m.created_at desc limit least(greatest(coalesce(p_limit,20),1),100);
$$;

revoke all on function public.retrieve_engineering_outcome_memory(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.retrieve_engineering_outcome_memory(uuid, uuid, integer) to service_role;
