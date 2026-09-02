-- 2026-09-02 correction (never applied anywhere): the fingerprint helpers below
-- called bare digest(), which does not resolve under `set search_path = public`
-- because pgcrypto is installed in the `extensions` schema. The SQL-language
-- helpers failed at CREATE time, so this migration could not be applied at all.
-- Qualified as extensions.digest(...) rather than widening search_path, which
-- would broaden unqualified name resolution inside a SECURITY DEFINER body.
-- Safe to correct in place: this version has never been recorded in any
-- environment's ledger and none of its objects exist in production.

-- Extend the canonical recommendation decision record added in 20260901012000.
-- This remains a decision/audit layer only. Existing action/tool primitives own execution.

alter table public.caye_recommendation_decisions
  drop constraint if exists caye_recommendation_decisions_decision_check;
alter table public.caye_recommendation_decisions
  add constraint caye_recommendation_decisions_decision_check
  check (decision in ('pending','accepted','rejected','deferred','cancelled'));

alter table public.caye_recommendation_decisions
  add column if not exists risk_at_decision text
    check (risk_at_decision in ('low','medium','high','critical')),
  add column if not exists recommendation_version text;

create or replace function public.caye_recommendation_version(p_recommendation_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select encode(extensions.digest(concat_ws('|',
    'caye-recommendation-decision-version-v1',
    r.fingerprint,
    r.recommendation,
    r.expected_impact,
    r.urgency,
    r.reversibility,
    r.risk_classification,
    r.required_authority::text
  ), 'sha256'), 'hex')
  from public.caye_recommendations r
  where r.id = p_recommendation_id;
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
  v_version text;
begin
  select * into v_rec
  from public.caye_recommendations
  where id = p_recommendation_id
  for update;
  if not found then raise exception 'recommendation not found'; end if;

  if v_rec.workspace_id is distinct from p_workspace_id then
    raise exception 'recommendation decision workspace mismatch';
  end if;
  if p_decision not in ('pending','accepted','rejected','deferred','cancelled') then
    raise exception 'unsupported recommendation decision';
  end if;
  if p_actor_kind not in ('founder','operator','system') then
    raise exception 'unsupported recommendation decision actor';
  end if;
  if p_actor_kind in ('founder','operator') and nullif(btrim(coalesce(p_actor_id,'')), '') is null then
    raise exception 'human recommendation decision requires actor identity';
  end if;
  if nullif(btrim(coalesce(p_rationale,'')), '') is null then
    raise exception 'recommendation decision reason is required';
  end if;
  if p_actor_kind = 'system' and (p_authority_provenance is null or p_authority_provenance = '{}'::jsonb) then
    raise exception 'autonomous decision requires existing authority provenance';
  end if;
  if p_authority_provenance is null or jsonb_typeof(p_authority_provenance) <> 'object' then
    raise exception 'decision authority provenance must be an object';
  end if;
  if v_rec.status in ('superseded','withdrawn') and p_decision = 'accepted' then
    raise exception 'stale recommendation cannot be accepted';
  end if;

  v_version := public.caye_recommendation_version(v_rec.id);
  if v_version is null then raise exception 'recommendation version unavailable'; end if;

  v_fingerprint := encode(extensions.digest(concat_ws('|',
    'caye-recommendation-decision-v2',
    p_recommendation_id::text,
    v_version,
    p_decision,
    p_actor_kind,
    coalesce(p_actor_id,''),
    coalesce(nullif(btrim(p_idempotency_key),''), lower(regexp_replace(btrim(coalesce(p_rationale,'')), '\\s+', ' ', 'g')))
  ), 'sha256'), 'hex');

  insert into public.caye_recommendation_decisions (
    recommendation_id, recommendation_fingerprint, scope, workspace_id,
    decision, actor_kind, actor_id, rationale, authority_provenance,
    fingerprint, risk_at_decision, recommendation_version, decided_at
  ) values (
    v_rec.id, v_rec.fingerprint, v_rec.scope, v_rec.workspace_id,
    p_decision, p_actor_kind,
    nullif(btrim(coalesce(p_actor_id,'')),''), btrim(p_rationale),
    p_authority_provenance, v_fingerprint, v_rec.risk_classification,
    v_version, coalesce(p_decided_at, now())
  )
  on conflict (fingerprint) do update set
    authority_provenance = case
      when public.caye_recommendation_decisions.authority_provenance = '{}'::jsonb
        then excluded.authority_provenance
      else public.caye_recommendation_decisions.authority_provenance
    end
  returning * into v_row;

  -- Pending is durable blocked state, not a recommendation outcome.
  if p_decision <> 'pending' and v_row.decision = p_decision then
    v_status := case p_decision
      when 'accepted' then 'accepted'
      when 'rejected' then 'rejected'
      when 'deferred' then 'deferred'
      when 'cancelled' then 'withdrawn'
    end;
    update public.caye_recommendations
    set status = v_status, updated_at = now()
    where id = v_rec.id and status <> 'superseded';
  end if;

  return v_row;
end;
$$;

create or replace function public.caye_recommendation_execution_eligible(
  p_recommendation_id uuid,
  p_workspace_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rec public.caye_recommendations%rowtype;
  v_decision public.caye_recommendation_decisions%rowtype;
  v_version text;
begin
  select * into v_rec from public.caye_recommendations where id = p_recommendation_id;
  if not found then return false; end if;
  if v_rec.workspace_id is distinct from p_workspace_id then return false; end if;
  if v_rec.status in ('superseded','withdrawn') then return false; end if;

  v_version := public.caye_recommendation_version(v_rec.id);
  if v_version is null then return false; end if;

  select * into v_decision
  from public.caye_recommendation_decisions
  where recommendation_id = v_rec.id
  order by decided_at desc, created_at desc, id desc
  limit 1;

  return found
    and v_decision.decision = 'accepted'
    and v_decision.recommendation_fingerprint = v_rec.fingerprint
    and v_decision.recommendation_version = v_version;
end;
$$;

revoke all on function public.caye_recommendation_version(uuid) from public, anon, authenticated;
revoke all on function public.caye_recommendation_execution_eligible(uuid, uuid) from public, anon, authenticated;
grant execute on function public.caye_recommendation_version(uuid) to service_role;
grant execute on function public.caye_recommendation_execution_eligible(uuid, uuid) to service_role;

comment on function public.caye_recommendation_execution_eligible(uuid, uuid) is
  'Recommendation-level execution eligibility only; existing action/tool gates remain the execution boundary.';
