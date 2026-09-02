-- Forward fix for a latent defect in two ALREADY-APPLIED functions.
--
-- 20260901010500_canonical_evidence_backed_recommendations and
-- 20260901012000_canonical_recommendation_decisions are both recorded in the
-- production ledger and their tables exist. But both functions compute a
-- fingerprint with bare digest() while declared `set search_path = public`,
-- and pgcrypto is installed in the `extensions` schema. plpgsql resolves
-- function names at execution, not at CREATE, so both were created cleanly and
-- have thrown 42883 on every real call since:
--
--   ERROR 42883: function digest(unknown, unknown) does not exist
--
-- Neither has ever succeeded. public.caye_recommendations and
-- public.caye_recommendation_decisions are both empty, which is the evidence:
-- the only writers are these two functions.
--
-- Those two migrations are NOT edited. History stays as applied; this
-- migration carries the correction forward.
--
-- The fix is schema qualification (extensions.digest) rather than
-- `set search_path = public, extensions`. Adding a schema to a SECURITY
-- DEFINER search_path broadens unqualified name resolution for every
-- identifier in the body, which is a security change; qualifying one call site
-- is not, and it makes the pgcrypto dependency legible where it is used.
--
-- Everything else is byte-identical to the applied definitions: same
-- signatures, same bodies, same SECURITY DEFINER, same `set search_path =
-- public`, same revoke/grant. `create or replace` preserves the existing
-- objects; no decision or recommendation row is read or written here.

create or replace function public.upsert_grounded_caye_recommendation(
  p_goal_id uuid,
  p_title text,
  p_recommendation text,
  p_rationale text,
  p_confidence numeric,
  p_expected_impact text,
  p_urgency text,
  p_reversibility text,
  p_risk_classification text,
  p_required_authority jsonb,
  p_intelligence_item_ids uuid[],
  p_belief_revision_ids uuid[] default '{}'::uuid[],
  p_evidence_claim_ids uuid[] default '{}'::uuid[],
  p_provenance jsonb default '{}'::jsonb
)
returns public.caye_recommendations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_goal public.caye_goals%rowtype;
  v_row public.caye_recommendations%rowtype;
  v_item_id uuid;
  v_revision_id uuid;
  v_claim_id uuid;
  v_item_ids uuid[];
  v_revision_ids uuid[];
  v_claim_ids uuid[];
  v_confidence_ceiling numeric;
  v_fingerprint text;
begin
  if p_goal_id is null then raise exception 'recommendation requires a canonical goal'; end if;
  if length(btrim(coalesce(p_title,''))) = 0
     or length(btrim(coalesce(p_recommendation,''))) = 0
     or length(btrim(coalesce(p_rationale,''))) = 0
     or length(btrim(coalesce(p_expected_impact,''))) = 0 then
    raise exception 'recommendation title, action, rationale, and expected impact are required';
  end if;
  if p_confidence is null or p_confidence < 0 or p_confidence > 1 then
    raise exception 'recommendation confidence must be between 0 and 1';
  end if;
  if p_urgency not in ('low','medium','high','immediate') then raise exception 'unsupported recommendation urgency'; end if;
  if p_reversibility not in ('easy','moderate','hard','irreversible') then raise exception 'unsupported recommendation reversibility'; end if;
  if p_risk_classification not in ('low','medium','high','critical') then raise exception 'unsupported recommendation risk classification'; end if;
  if p_required_authority is null or jsonb_typeof(p_required_authority) <> 'object' then
    raise exception 'recommendation requires resolved authority metadata';
  end if;

  select * into v_goal from public.caye_goals where id = p_goal_id for share;
  if not found then raise exception 'recommendation goal not found'; end if;
  if v_goal.status <> 'active' or v_goal.superseded_at is not null then
    raise exception 'recommendation target must be an active non-superseded canonical goal';
  end if;

  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_item_ids
  from unnest(coalesce(p_intelligence_item_ids, '{}'::uuid[])) as u(x);
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_revision_ids
  from unnest(coalesce(p_belief_revision_ids, '{}'::uuid[])) as u(x);
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_claim_ids
  from unnest(coalesce(p_evidence_claim_ids, '{}'::uuid[])) as u(x);

  if cardinality(v_item_ids) = 0 then
    raise exception 'recommendation requires originating intelligence';
  end if;
  if cardinality(v_claim_ids) = 0 then
    raise exception 'recommendation requires canonical research claim evidence';
  end if;

  if exists (
    select 1 from unnest(v_item_ids) u(id)
    left join public.intelligence_items i on i.id = u.id
    where i.id is null
  ) then raise exception 'recommendation references unknown intelligence'; end if;

  -- Global intelligence may inform any scoped goal. Non-global intelligence
  -- must match the recommendation/goal scope exactly, preventing workspace
  -- leakage while still allowing globally researched facts to affect a goal.
  if exists (
    select 1
    from public.intelligence_items i
    where i.id = any(v_item_ids)
      and i.scope <> 'global'
      and (
        i.scope is distinct from v_goal.scope
        or i.workspace_id is distinct from v_goal.workspace_id
      )
  ) then
    raise exception 'recommendation intelligence must be global or share goal scope and workspace';
  end if;

  if exists (
    select 1 from public.intelligence_items i
    where i.id = any(v_item_ids)
      and i.status not in ('current','contested')
  ) then
    raise exception 'recommendation intelligence must be current or contested';
  end if;

  -- Reuse the existing canonical intelligence -> goal bridge. At least one
  -- originating item must already have an evidence-backed impact on this goal.
  if not exists (
    select 1 from public.intelligence_goal_impacts gi
    where gi.goal_id = p_goal_id
      and gi.intelligence_item_id = any(v_item_ids)
  ) then
    raise exception 'recommendation requires a canonical intelligence goal impact';
  end if;

  if exists (
    select 1
    from unnest(v_revision_ids) u(id)
    left join public.intelligence_belief_revisions r on r.id = u.id
    where r.id is null or not (r.intelligence_item_id = any(v_item_ids))
  ) then
    raise exception 'recommendation belief revisions must belong to originating intelligence';
  end if;

  if exists (
    select 1 from unnest(v_claim_ids) u(id)
    left join public.research_claims c on c.id = u.id
    where c.id is null
  ) then raise exception 'recommendation evidence contains an unknown research claim'; end if;

  -- Founder wording/model prose is never evidence. Every supplied claim must
  -- already ground an originating intelligence item or one of its supplied
  -- belief revisions through the canonical provenance edges.
  if exists (
    select 1
    from unnest(v_claim_ids) u(id)
    where not exists (
      select 1 from public.intelligence_item_claims ic
      where ic.claim_id = u.id and ic.intelligence_item_id = any(v_item_ids)
    )
    and not exists (
      select 1
      from public.intelligence_belief_revision_claims rc
      where rc.claim_id = u.id and rc.revision_id = any(v_revision_ids)
    )
  ) then
    raise exception 'recommendation evidence must already exist in canonical intelligence provenance';
  end if;

  -- Do not flatten uncertainty upward. The recommendation cannot claim more
  -- confidence than the weakest non-null originating belief/revision it cites.
  select min(bound) into v_confidence_ceiling
  from (
    select i.confidence as bound from public.intelligence_items i
      where i.id = any(v_item_ids) and i.confidence is not null
    union all
    select r.revised_confidence as bound from public.intelligence_belief_revisions r
      where r.id = any(v_revision_ids)
  ) bounds;
  if v_confidence_ceiling is not null and p_confidence > v_confidence_ceiling then
    raise exception 'recommendation confidence exceeds evidence-supported bound';
  end if;

  v_fingerprint := encode(extensions.digest(
    concat_ws('|',
      'caye-recommendation-v1',
      v_goal.scope,
      coalesce(v_goal.workspace_id::text, ''),
      p_goal_id::text,
      lower(regexp_replace(btrim(p_recommendation), '\\s+', ' ', 'g')),
      array_to_string(v_item_ids, ','),
      array_to_string(v_revision_ids, ','),
      array_to_string(v_claim_ids, ',')
    ), 'sha256'
  ), 'hex');

  insert into public.caye_recommendations (
    scope, workspace_id, goal_id, title, recommendation, rationale, status,
    confidence, expected_impact, urgency, reversibility, risk_classification,
    required_authority, fingerprint, provenance, updated_at
  ) values (
    v_goal.scope, v_goal.workspace_id, p_goal_id, btrim(p_title),
    btrim(p_recommendation), btrim(p_rationale), 'proposed', p_confidence,
    btrim(p_expected_impact), p_urgency, p_reversibility, p_risk_classification,
    p_required_authority, v_fingerprint, coalesce(p_provenance, '{}'::jsonb), now()
  )
  on conflict (fingerprint) do update set
    title = excluded.title,
    recommendation = excluded.recommendation,
    rationale = excluded.rationale,
    confidence = excluded.confidence,
    expected_impact = excluded.expected_impact,
    urgency = excluded.urgency,
    reversibility = excluded.reversibility,
    risk_classification = excluded.risk_classification,
    required_authority = excluded.required_authority,
    provenance = case
      when public.caye_recommendations.provenance = '{}'::jsonb then excluded.provenance
      when excluded.provenance = '{}'::jsonb then public.caye_recommendations.provenance
      else public.caye_recommendations.provenance || excluded.provenance
    end,
    updated_at = now()
  returning * into v_row;

  foreach v_item_id in array v_item_ids loop
    insert into public.caye_recommendation_intelligence(recommendation_id, intelligence_item_id)
    values (v_row.id, v_item_id) on conflict do nothing;
  end loop;
  foreach v_revision_id in array v_revision_ids loop
    insert into public.caye_recommendation_belief_revisions(recommendation_id, belief_revision_id)
    values (v_row.id, v_revision_id) on conflict do nothing;
  end loop;
  foreach v_claim_id in array v_claim_ids loop
    insert into public.caye_recommendation_claims(recommendation_id, claim_id)
    values (v_row.id, v_claim_id) on conflict do nothing;
  end loop;

  return v_row;
end;
$$;

create or replace function public.record_caye_recommendation_decision(
  p_recommendation_id uuid,
  p_decision text,
  p_actor_kind text,
  p_actor_id text default null,
  p_rationale text default null,
  p_authority_provenance jsonb default '{}'::jsonb,
  p_workspace_id uuid default null,
  p_idempotency_key text default null,
  p_decided_at timestamptz default now()
)
returns public.caye_recommendation_decisions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec public.caye_recommendations%rowtype;
  v_row public.caye_recommendation_decisions%rowtype;
  v_status text;
  v_fingerprint text;
begin
  select * into v_rec
  from public.caye_recommendations
  where id = p_recommendation_id
  for update;
  if not found then raise exception 'recommendation not found'; end if;

  if v_rec.workspace_id is distinct from p_workspace_id then
    raise exception 'recommendation decision workspace mismatch';
  end if;
  if p_decision not in ('accepted','rejected','deferred','cancelled') then
    raise exception 'unsupported recommendation decision';
  end if;
  if p_actor_kind not in ('founder','operator','system') then
    raise exception 'unsupported recommendation decision actor';
  end if;
  if p_actor_kind = 'system' and (p_authority_provenance is null or p_authority_provenance = '{}'::jsonb) then
    raise exception 'autonomous decision requires existing authority provenance';
  end if;
  if p_authority_provenance is null or jsonb_typeof(p_authority_provenance) <> 'object' then
    raise exception 'decision authority provenance must be an object';
  end if;

  -- The caller must supply provenance from the existing authority path. This
  -- function records the result; it never interprets required_authority as a grant.
  -- The canonical recommendation fingerprint is part of the immutable decision
  -- identity and is snapshotted so stale approvals cannot silently apply to a
  -- materially changed recommendation version.
  v_fingerprint := encode(extensions.digest(concat_ws('|',
    'caye-recommendation-decision-v1',
    p_recommendation_id::text,
    v_rec.fingerprint,
    p_decision,
    p_actor_kind,
    coalesce(p_actor_id,''),
    coalesce(nullif(btrim(p_idempotency_key),''), lower(regexp_replace(btrim(coalesce(p_rationale,'')), '\\s+', ' ', 'g')))
  ), 'sha256'), 'hex');

  insert into public.caye_recommendation_decisions (
    recommendation_id, recommendation_fingerprint, scope, workspace_id,
    decision, actor_kind, actor_id, rationale, authority_provenance,
    fingerprint, decided_at
  ) values (
    v_rec.id, v_rec.fingerprint, v_rec.scope, v_rec.workspace_id,
    p_decision, p_actor_kind,
    nullif(btrim(coalesce(p_actor_id,'')),''), nullif(btrim(coalesce(p_rationale,'')),''),
    p_authority_provenance, v_fingerprint, coalesce(p_decided_at, now())
  )
  on conflict (fingerprint) do update set
    authority_provenance = case
      when public.caye_recommendation_decisions.authority_provenance = '{}'::jsonb
        then excluded.authority_provenance
      else public.caye_recommendation_decisions.authority_provenance
    end
  returning * into v_row;

  v_status := case p_decision
    when 'accepted' then 'accepted'
    when 'rejected' then 'rejected'
    when 'deferred' then 'deferred'
    when 'cancelled' then 'withdrawn'
  end;

  -- Decision status is mirrored onto the canonical recommendation for discovery.
  -- No execution state is created or inferred here.
  update public.caye_recommendations
  set status = v_status, updated_at = now()
  where id = v_rec.id
    and status <> 'superseded';

  return v_row;
end;
$$;

-- Re-assert the intended privilege posture. `create or replace` keeps whatever
-- grants the function already had, so these are a no-op on a correctly-granted
-- function and a repair if anything ever widened them. anon/authenticated are
-- explicitly revoked: both functions are service-role-only writers.
revoke all on function public.upsert_grounded_caye_recommendation(
  uuid, text, text, text, numeric, text, text, text, text, jsonb, uuid[], uuid[], uuid[], jsonb
) from public, anon, authenticated;
grant execute on function public.upsert_grounded_caye_recommendation(
  uuid, text, text, text, numeric, text, text, text, text, jsonb, uuid[], uuid[], uuid[], jsonb
) to service_role;

revoke all on function public.record_caye_recommendation_decision(
  uuid, text, text, text, text, jsonb, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_caye_recommendation_decision(
  uuid, text, text, text, text, jsonb, uuid, text, timestamptz
) to service_role;
