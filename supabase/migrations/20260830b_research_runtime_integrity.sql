-- Research Runtime V1 integrity hardening.
-- 1) every stored source has a stable hash so (url,hash) dedupe is real;
-- 2) claims + evidence edges + brief revision + run completion commit atomically.

update public.research_sources
set content_hash = encode(digest(canonical_url || ':' || snapshot::text, 'sha256'), 'hex')
where content_hash is null;

alter table public.research_sources alter column content_hash set not null;

create or replace function public.persist_research_synthesis(
  p_run_id uuid,
  p_question_id uuid,
  p_provider text,
  p_claims jsonb,
  p_brief jsonb
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.research_runs%rowtype;
  v_claim jsonb;
  v_claim_id uuid;
  v_source_id uuid;
  v_revision integer;
  v_evidence jsonb;
begin
  select * into v_run
  from public.research_runs
  where id = p_run_id
  for update;

  if not found or v_run.question_id <> p_question_id then
    raise exception 'research run/question mismatch';
  end if;
  if v_run.status <> 'running' then
    raise exception 'research run must be running';
  end if;
  if jsonb_typeof(p_claims) <> 'array' or jsonb_array_length(p_claims) = 0 then
    raise exception 'research synthesis requires claims';
  end if;

  -- Lock the question so concurrent revisions cannot choose the same number.
  perform 1 from public.research_questions where id = p_question_id for update;
  select coalesce(max(revision), 0) + 1 into v_revision
  from public.research_briefs where question_id = p_question_id;

  for v_claim in select value from jsonb_array_elements(p_claims)
  loop
    v_evidence := v_claim->'evidence';
    if jsonb_typeof(v_evidence) <> 'array' or jsonb_array_length(v_evidence) = 0 then
      raise exception 'material research claim lacks evidence';
    end if;

    -- Validate every cited source was actually observed by this run before
    -- inserting the claim. A model cannot cite an arbitrary source id.
    for v_source_id in
      select value::text::uuid from jsonb_array_elements_text(v_evidence)
    loop
      if not exists (
        select 1 from public.research_run_sources
        where run_id = p_run_id and source_id = v_source_id
      ) then
        raise exception 'claim evidence source was not observed by this run';
      end if;
    end loop;

    insert into public.research_claims(
      question_id, run_id, claim_type, statement, confidence, source_quality, provenance
    ) values (
      p_question_id,
      p_run_id,
      coalesce(v_claim->>'claim_type', 'finding'),
      v_claim->>'statement',
      nullif(v_claim->>'confidence','')::numeric,
      nullif(v_claim->>'source_quality',''),
      jsonb_build_object('provider', p_provider)
    ) returning id into v_claim_id;

    insert into public.research_claim_evidence(claim_id, source_id, stance)
    select v_claim_id, value::text::uuid, 'supports'
    from jsonb_array_elements_text(v_evidence);
  end loop;

  insert into public.research_briefs(
    question_id, run_id, revision, current_understanding,
    strongest_evidence, conflicting_evidence, unknowns, material_changes,
    implications, recommendations, provenance
  ) values (
    p_question_id,
    p_run_id,
    v_revision,
    p_brief->>'current_understanding',
    coalesce(p_brief->'strongest_evidence', '[]'::jsonb),
    coalesce(p_brief->'conflicting_evidence', '[]'::jsonb),
    coalesce(p_brief->'unknowns', '[]'::jsonb),
    coalesce(p_brief->'material_changes', '[]'::jsonb),
    coalesce(p_brief->'implications', '[]'::jsonb),
    coalesce(p_brief->'recommendations', '[]'::jsonb),
    jsonb_build_object('provider', p_provider)
  );

  update public.research_runs
  set status = 'completed', completed_at = now(), provider = p_provider, error = null
  where id = p_run_id;

  return v_revision;
end
$$;

revoke all on function public.persist_research_synthesis(uuid,uuid,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.persist_research_synthesis(uuid,uuid,text,jsonb,jsonb) to service_role;

create or replace function public.supersede_research_claim(
  p_old_claim_id uuid,
  p_new_claim_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_question uuid;
  v_new_question uuid;
begin
  select question_id into v_old_question from public.research_claims where id = p_old_claim_id for update;
  select question_id into v_new_question from public.research_claims where id = p_new_claim_id;
  if v_old_question is null or v_new_question is null or v_old_question <> v_new_question then
    raise exception 'claims must exist and belong to the same research question';
  end if;
  update public.research_claims
  set status = 'superseded', valid_until = now(), superseded_by = p_new_claim_id
  where id = p_old_claim_id and status in ('current','contested');
end
$$;

revoke all on function public.supersede_research_claim(uuid,uuid) from public, anon, authenticated;
grant execute on function public.supersede_research_claim(uuid,uuid) to service_role;