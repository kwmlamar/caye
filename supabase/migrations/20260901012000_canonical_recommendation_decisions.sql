-- Canonical decision records for evidence-backed recommendations.
--
-- This records a decision already made through Caye's existing founder/operator
-- or autonomous authority paths. It does not grant authority and it does not
-- create an execution engine. Acceptance is explicitly not execution evidence.

create table if not exists public.caye_recommendation_decisions (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references public.caye_recommendations(id) on delete restrict,
  recommendation_fingerprint text not null,
  scope text not null check (scope in ('operator','workspace')),
  workspace_id uuid references public.customers(id) on delete cascade,
  decision text not null check (decision in ('accepted','rejected','deferred','cancelled')),
  actor_kind text not null check (actor_kind in ('founder','operator','system')),
  actor_id text,
  rationale text,
  authority_provenance jsonb not null default '{}'::jsonb,
  fingerprint text not null unique,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint caye_recommendation_decisions_scope_workspace_pairing check (
    (scope = 'workspace' and workspace_id is not null) or
    (scope = 'operator' and workspace_id is null)
  )
);

create index if not exists caye_recommendation_decisions_recommendation_idx
  on public.caye_recommendation_decisions(recommendation_id, decided_at desc);
create index if not exists caye_recommendation_decisions_workspace_idx
  on public.caye_recommendation_decisions(workspace_id, decided_at desc)
  where scope = 'workspace';

alter table public.caye_recommendation_decisions enable row level security;
revoke all on public.caye_recommendation_decisions from anon, authenticated;

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
  v_fingerprint := encode(digest(concat_ws('|',
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

revoke all on function public.record_caye_recommendation_decision(
  uuid, text, text, text, text, jsonb, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_caye_recommendation_decision(
  uuid, text, text, text, text, jsonb, uuid, text, timestamptz
) to service_role;

comment on table public.caye_recommendation_decisions is
  'Durable version-pinned decisions on canonical recommendations. Authority is supplied as provenance from existing authority machinery; acceptance is not execution evidence.';