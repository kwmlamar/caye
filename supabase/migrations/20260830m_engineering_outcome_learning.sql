-- Adaptive engineering outcome learning.
-- Domain evidence tables remain authoritative. operator_learning_audit stores candidate/validation history.
-- business_facts receives only validated, derived, property-scoped lessons.

create or replace function public.capture_engineering_verdict_learning()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_property_id uuid;
  v_prior_memory_id uuid;
  v_new_memory_id uuid;
  v_evidence_count integer := 0;
  v_contributing_projects jsonb := '[]'::jsonb;
  v_confidence numeric;
  v_canonical_key text;
begin
  if new.verdict = 'inconclusive' then
    return new;
  end if;

  -- Attempted or merely asserted work is not learning evidence. A candidate
  -- requires both execution evidence and an independently linked actual outcome.
  if not exists (
    select 1
    from public.engineering_project_execution_evidence e
    where e.workspace_id = new.workspace_id
      and e.project_id = new.project_id
  ) or not exists (
    select 1
    from public.engineering_project_outcomes o
    where o.workspace_id = new.workspace_id
      and o.project_id = new.project_id
  ) then
    return new;
  end if;

  select p.property_id
    into v_property_id
  from public.engineering_projects p
  where p.workspace_id = new.workspace_id
    and p.id = new.project_id;

  if v_property_id is null then
    raise exception 'Engineering verdict project scope could not be resolved';
  end if;

  v_canonical_key := 'engineering_outcome:property:' || v_property_id::text;

  -- Every evidence-backed verdict is first a candidate. This is durable audit
  -- history, not reusable operating memory.
  insert into public.operator_learning_audit (
    workspace_id,
    source_message_id,
    source_excerpt,
    classifier_version,
    explicitness,
    scope_kind,
    scope_target,
    risk_level,
    destination,
    canonical_key,
    decision,
    target_table,
    target_record_id,
    reason
  ) values (
    new.workspace_id,
    new.source_message_id,
    left(new.summary, 1000),
    'engineering_outcome_learning_v2',
    'inferred_from_action',
    'standing',
    'workspace',
    'consequential',
    'business_fact',
    v_canonical_key,
    'candidate',
    'engineering_project_verdicts',
    new.id::text,
    format('Evidence-backed engineering verdict %s is a candidate lesson; validation requires at least 2 independent verified projects on the same property with the same verdict.', new.verdict)
  );

  -- Validation threshold: two independent projects, same workspace/property and
  -- same conclusive verdict, each with execution evidence and an actual outcome.
  select
    count(distinct v.project_id)::integer,
    coalesce(jsonb_agg(distinct v.project_id), '[]'::jsonb)
  into v_evidence_count, v_contributing_projects
  from public.engineering_project_verdicts v
  join public.engineering_projects p
    on p.workspace_id = v.workspace_id
   and p.id = v.project_id
  where v.workspace_id = new.workspace_id
    and p.property_id = v_property_id
    and v.verdict = new.verdict
    and v.verdict <> 'inconclusive'
    and v.superseded_at is null
    and exists (
      select 1
      from public.engineering_project_execution_evidence e
      where e.workspace_id = v.workspace_id
        and e.project_id = v.project_id
    )
    and exists (
      select 1
      from public.engineering_project_outcomes o
      where o.workspace_id = v.workspace_id
        and o.project_id = v.project_id
    );

  if v_evidence_count < 2 then
    return new;
  end if;

  -- One active derived engineering lesson per property. A later validated
  -- pattern supersedes the previous derived lesson, but never explicit/human memory.
  select f.id
    into v_prior_memory_id
  from public.business_facts f
  where f.workspace_id = new.workspace_id
    and f.canonical_key = v_canonical_key
    and f.subject_type = 'property'
    and f.subject_id = v_property_id::text
    and f.memory_type = 'outcome'
    and f.knowledge_mode = 'derived'
    and f.authority_kind = 'system'
    and f.superseded_at is null
  order by f.created_at desc
  limit 1;

  v_confidence := least(
    case new.verdict
      when 'succeeded' then 0.82
      when 'failed' then 0.82
      when 'partially_succeeded' then 0.76
      else 0.70
    end + greatest(v_evidence_count - 2, 0) * 0.04,
    0.95
  );

  perform public.write_typed_business_memory_atomic(
    p_workspace_id := new.workspace_id,
    p_category := 'service_detail',
    p_fact := format(
      'Validated engineering outcome lesson for this property: %s across %s independent verified projects. Use this as evidence when making later engineering recommendations; explicit human knowledge and newer contradictory validated evidence outrank it.',
      new.verdict,
      v_evidence_count
    ),
    p_source := 'system-derived',
    p_created_by := 'engineering_verdict_learning_v2',
    p_service_id := null,
    p_canonical_key := v_canonical_key,
    p_expires_at := null,
    p_supersede_id := v_prior_memory_id,
    p_memory_type := 'outcome',
    p_subject_type := 'property',
    p_subject_id := v_property_id::text,
    p_knowledge_mode := 'derived',
    p_confidence := v_confidence,
    p_valid_from := new.created_at,
    p_sensitivity := 'workspace',
    p_authority_kind := 'system',
    p_provenance := jsonb_build_object(
      'kind', 'engineering_project_verdict_pattern',
      'property_id', v_property_id,
      'trigger_verdict_id', new.id,
      'verdict', new.verdict,
      'reason_codes', new.reason_codes,
      'source_message_id', new.source_message_id,
      'evidence_count', v_evidence_count,
      'minimum_evidence_threshold', 2,
      'contributing_project_ids', v_contributing_projects,
      'execution_evidence_required', true,
      'outcome_evidence_required', true,
      'candidate_before_validation', true
    ),
    p_contradicts_fact_id := null,
    p_correction_of_fact_id := null
  );

  select f.id
    into v_new_memory_id
  from public.business_facts f
  where f.workspace_id = new.workspace_id
    and f.canonical_key = v_canonical_key
    and f.subject_type = 'property'
    and f.subject_id = v_property_id::text
    and f.memory_type = 'outcome'
    and f.knowledge_mode = 'derived'
    and f.authority_kind = 'system'
    and f.superseded_at is null
  order by f.created_at desc
  limit 1;

  insert into public.operator_learning_audit (
    workspace_id,
    source_message_id,
    source_excerpt,
    classifier_version,
    explicitness,
    scope_kind,
    scope_target,
    risk_level,
    destination,
    canonical_key,
    decision,
    target_table,
    target_record_id,
    superseded_record_id,
    reason
  ) values (
    new.workspace_id,
    new.source_message_id,
    left(new.summary, 1000),
    'engineering_outcome_learning_v2',
    'inferred_from_action',
    'standing',
    'workspace',
    'consequential',
    'business_fact',
    v_canonical_key,
    case when v_prior_memory_id is null then 'written' else 'superseded_and_written' end,
    'business_facts',
    v_new_memory_id::text,
    v_prior_memory_id::text,
    format('Validated after %s independent verified engineering projects produced verdict %s for this property.', v_evidence_count, new.verdict)
  );

  return new;
end;
$$;

revoke all on function public.capture_engineering_verdict_learning() from public, anon, authenticated;
grant execute on function public.capture_engineering_verdict_learning() to service_role;

drop trigger if exists engineering_verdict_learning_after_insert on public.engineering_project_verdicts;
create trigger engineering_verdict_learning_after_insert
after insert on public.engineering_project_verdicts
for each row execute function public.capture_engineering_verdict_learning();

create or replace function public.retrieve_engineering_outcome_memory(
  p_workspace_id uuid,
  p_property_id uuid,
  p_limit integer default 20
)
returns table (
  id uuid,
  fact text,
  confidence numeric,
  provenance jsonb,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.fact, m.confidence, m.provenance, m.created_at
  from public.retrieve_operating_memory(
    p_workspace_id,
    null,
    array['outcome']::text[],
    'property',
    p_property_id::text,
    false,
    least(greatest(coalesce(p_limit, 20), 1), 100)
  ) m
  where m.memory_type = 'outcome'
    and m.subject_type = 'property'
    and m.subject_id = p_property_id::text
    and m.knowledge_mode = 'derived'
    and m.authority_kind = 'system'
    and coalesce((m.provenance->>'minimum_evidence_threshold')::integer, 0) >= 2
    and coalesce((m.provenance->>'evidence_count')::integer, 0) >= coalesce((m.provenance->>'minimum_evidence_threshold')::integer, 2)
  order by m.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

revoke all on function public.retrieve_engineering_outcome_memory(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.retrieve_engineering_outcome_memory(uuid, uuid, integer) to service_role;
