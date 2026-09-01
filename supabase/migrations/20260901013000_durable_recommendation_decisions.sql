-- Durable recommendation decision lifecycle.
--
-- This is deliberately NOT an execution engine. Decisions reference the
-- canonical caye_recommendations substrate and only answer whether the current
-- recommendation version has human/autonomous approval. Existing action/tool
-- execution gates remain authoritative for execution itself.

create table if not exists public.caye_recommendation_decisions (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references public.caye_recommendations(id) on delete restrict,
  scope text not null check (scope in ('operator','workspace')),
  workspace_id uuid references public.customers(id) on delete cascade,
  state text not null check (state in ('pending','accepted','rejected','deferred','cancelled')),
  actor_type text not null check (actor_type in ('founder','operator','caye','system')),
  actor_ref text,
  decision_reason text not null check (length(btrim(decision_reason)) > 0),
  authority_used jsonb not null default '{}'::jsonb,
  risk_at_decision text not null check (risk_at_decision in ('low','medium','high','critical')),
  recommendation_fingerprint text not null,
  recommendation_version text not null,
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint caye_recommendation_decisions_scope_workspace_pairing check (
    (scope = 'workspace' and workspace_id is not null) or
    (scope = 'operator' and workspace_id is null)
  ),
  constraint caye_recommendation_decisions_human_actor_ref check (
    actor_type not in ('founder','operator') or actor_ref is not null
  ),
  unique (recommendation_id, idempotency_key)
);

create index if not exists caye_recommendation_decisions_latest_idx
  on public.caye_recommendation_decisions(recommendation_id, decided_at desc, created_at desc);
create index if not exists caye_recommendation_decisions_workspace_idx
  on public.caye_recommendation_decisions(workspace_id, decided_at desc)
  where workspace_id is not null;

alter table public.caye_recommendation_decisions enable row level security;
revoke all on public.caye_recommendation_decisions from anon, authenticated;

-- A recommendation's original fingerprint intentionally identifies its
-- evidence/action synthesis. Decision eligibility needs a stricter version:
-- mutable decision-relevant fields are included so a risk/authority/
-- reversibility change cannot silently inherit an older acceptance.
create or replace function public.caye_recommendation_version(p_recommendation_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select encode(digest(
    concat_ws('|',
      'caye-recommendation-decision-v1',
      r.fingerprint,
      r.recommendation,
      r.expected_impact,
      r.urgency,
      r.reversibility,
      r.risk_classification,
      r.required_authority::text
    ), 'sha256'
  ), 'hex')
  from public.caye_recommendations r
  where r.id = p_recommendation_id;
$$;

create or replace function public.record_caye_recommendation_decision(
  p_recommendation_id uuid,
  p_workspace_id uuid,
  p_state text,
  p_actor_type text,
  p_actor_ref text,
  p_decision_reason text,
  p_authority_used jsonb,
  p_idempotency_key text
)
returns public.caye_recommendation_decisions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recommendation public.caye_recommendations%rowtype;
  v_version text;
  v_row public.caye_recommendation_decisions%rowtype;
begin
  if p_state not in ('pending','accepted','rejected','deferred','cancelled') then
    raise exception 'unsupported recommendation decision state';
  end if;
  if p_actor_type not in ('founder','operator','caye','system') then
    raise exception 'unsupported recommendation decision actor';
  end if;
  if p_actor_type in ('founder','operator') and nullif(btrim(coalesce(p_actor_ref,'')), '') is null then
    raise exception 'human recommendation decision requires actor identity';
  end if;
  if nullif(btrim(coalesce(p_decision_reason,'')), '') is null then
    raise exception 'recommendation decision reason is required';
  end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')), '') is null then
    raise exception 'recommendation decision idempotency key is required';
  end if;

  select * into v_recommendation
  from public.caye_recommendations
  where id = p_recommendation_id
  for share;
  if not found then raise exception 'recommendation not found'; end if;

  -- Scope is validated at the database write boundary. A caller cannot decide
  -- a recommendation by presenting an id from another workspace.
  if v_recommendation.scope = 'workspace' then
    if p_workspace_id is distinct from v_recommendation.workspace_id then
      raise exception 'recommendation decision workspace mismatch';
    end if;
  elsif p_workspace_id is not null then
    raise exception 'operator recommendation cannot be decided in workspace scope';
  end if;

  -- Superseded/withdrawn recommendations are terminal inputs. A fresh
  -- recommendation/version must receive its own decision.
  if v_recommendation.status in ('superseded','withdrawn') and p_state = 'accepted' then
    raise exception 'stale recommendation cannot be accepted';
  end if;

  v_version := public.caye_recommendation_version(v_recommendation.id);
  if v_version is null then raise exception 'recommendation version unavailable'; end if;

  insert into public.caye_recommendation_decisions (
    recommendation_id, scope, workspace_id, state, actor_type, actor_ref,
    decision_reason, authority_used, risk_at_decision,
    recommendation_fingerprint, recommendation_version, idempotency_key
  ) values (
    v_recommendation.id, v_recommendation.scope, v_recommendation.workspace_id,
    p_state, p_actor_type, nullif(btrim(coalesce(p_actor_ref,'')), ''),
    btrim(p_decision_reason), coalesce(p_authority_used, '{}'::jsonb),
    v_recommendation.risk_classification, v_recommendation.fingerprint,
    v_version, btrim(p_idempotency_key)
  )
  on conflict (recommendation_id, idempotency_key) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row
    from public.caye_recommendation_decisions
    where recommendation_id = p_recommendation_id
      and idempotency_key = btrim(p_idempotency_key);
  end if;

  -- Recommendation status remains a useful read-model field, but the durable
  -- decision row above is the audit source of truth. Pending does not mutate
  -- recommendation status.
  if p_state in ('accepted','rejected','deferred') and v_row.state = p_state then
    update public.caye_recommendations
    set status = p_state,
        updated_at = now()
    where id = v_recommendation.id
      and status not in ('superseded','withdrawn');
  elsif p_state = 'cancelled' and v_row.state = 'cancelled' then
    update public.caye_recommendations
    set status = 'withdrawn',
        updated_at = now()
    where id = v_recommendation.id
      and status <> 'superseded';
  end if;

  return v_row;
end;
$$;

-- This answers recommendation-level eligibility only. Existing action/tool
-- gates still decide whether and how any accepted recommendation may execute.
create or replace function public.caye_recommendation_execution_eligible(
  p_recommendation_id uuid,
  p_workspace_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_recommendation public.caye_recommendations%rowtype;
  v_decision public.caye_recommendation_decisions%rowtype;
  v_version text;
begin
  select * into v_recommendation
  from public.caye_recommendations
  where id = p_recommendation_id;
  if not found then return false; end if;

  if v_recommendation.scope = 'workspace' then
    if p_workspace_id is distinct from v_recommendation.workspace_id then return false; end if;
  elsif p_workspace_id is not null then
    return false;
  end if;

  if v_recommendation.status in ('superseded','withdrawn') then return false; end if;

  v_version := public.caye_recommendation_version(v_recommendation.id);
  if v_version is null then return false; end if;

  select * into v_decision
  from public.caye_recommendation_decisions
  where recommendation_id = v_recommendation.id
  order by decided_at desc, created_at desc, id desc
  limit 1;

  return found
    and v_decision.state = 'accepted'
    and v_decision.recommendation_fingerprint = v_recommendation.fingerprint
    and v_decision.recommendation_version = v_version;
end;
$$;

revoke all on function public.caye_recommendation_version(uuid) from public, anon, authenticated;
revoke all on function public.record_caye_recommendation_decision(uuid, uuid, text, text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.caye_recommendation_execution_eligible(uuid, uuid) from public, anon, authenticated;
grant execute on function public.caye_recommendation_version(uuid) to service_role;
grant execute on function public.record_caye_recommendation_decision(uuid, uuid, text, text, text, text, jsonb, text) to service_role;
grant execute on function public.caye_recommendation_execution_eligible(uuid, uuid) to service_role;

comment on table public.caye_recommendation_decisions is
  'Durable auditable decisions against canonical recommendation versions. Does not execute actions.';
comment on function public.caye_recommendation_execution_eligible(uuid, uuid) is
  'Fail-closed recommendation-level execution eligibility. Existing action/tool execution gates remain authoritative.';
