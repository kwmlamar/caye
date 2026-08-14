-- Phase 4A: commercial truth and relationship-owned operating resources.
-- DEPLOYMENT ORDER: apply this migration before application code calls the
-- caye_record_commercial_engagement, caye_link_relationship_operating_workspace,
-- caye_verify_relationship_resource, or caye_revoke_relationship_resource RPCs.
-- This migration does not start, execute, or complete Caye jobs.

-- Needed by the resource composite FK: a connected account may only be linked
-- through the workspace that owns it.
create unique index if not exists connected_accounts_user_id_id_unique_idx
  on public.connected_accounts (user_id, id);

create table public.caye_commercial_engagements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  relationship_id uuid not null,
  engagement_type text not null check (engagement_type in ('one_time_paid', 'subscription', 'addon', 'other_approved_paid')),
  status text not null check (status in ('paid', 'active', 'ended')),
  source_system text not null check (source_system in ('stripe', 'chargeanywhere', 'approved_commercial_arrangement')),
  source_id text not null,
  terms_reference text,
  amount numeric,
  currency text,
  relationship_state_before text not null check (relationship_state_before in ('prospect', 'engaged', 'client', 'inactive')),
  started_at timestamptz not null,
  ended_at timestamptz,
  provenance_metadata jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_system, source_id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, relationship_id)
    references public.caye_relationships(workspace_id, id) on delete restrict,
  check ((amount is null and currency is null) or (amount is not null and currency ~ '^[A-Z]{3}$')),
  check (ended_at is null or ended_at >= started_at)
);

create index caye_commercial_engagements_relationship_active_idx
  on public.caye_commercial_engagements (workspace_id, relationship_id, started_at desc)
  where status in ('paid', 'active');

comment on table public.caye_commercial_engagements is
  'Canonical, source-backed paid commercial engagements with Caye/TropiTech. Workspace pricing maps, Sales won, and customer-business payments are not rows here.';

create table public.caye_relationship_operating_workspaces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  relationship_id uuid not null,
  operating_workspace_id uuid not null references public.customers(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'revoked')),
  verification_method text not null check (verification_method in ('verified_operating_workspace_owner')),
  verified_by_operator_id bigint not null,
  source_system text not null,
  source_id text not null,
  provenance_metadata jsonb not null default '{}'::jsonb,
  verified_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, relationship_id, operating_workspace_id),
  unique (workspace_id, relationship_id, operating_workspace_id, id),
  unique (workspace_id, relationship_id, source_system, source_id),
  foreign key (workspace_id, relationship_id)
    references public.caye_relationships(workspace_id, id) on delete restrict,
  foreign key (operating_workspace_id, verified_by_operator_id)
    references public.operator_allowlist(workspace_id, id) on delete restrict,
  check ((status = 'revoked') = (revoked_at is not null))
);

create unique index caye_relationship_operating_workspaces_one_active_idx
  on public.caye_relationship_operating_workspaces (workspace_id, relationship_id)
  where status = 'active';
create unique index caye_relationship_operating_workspaces_operating_id_unique_idx
  on public.caye_relationship_operating_workspaces (operating_workspace_id, id);

comment on table public.caye_relationship_operating_workspaces is
  'Verified mapping from an acquisition relationship to the separate workspace that owns its operating resources. The acquisition workspace is never inferred as the operating workspace.';

create table public.caye_relationship_resources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  relationship_id uuid not null,
  operating_workspace_id uuid not null references public.customers(id) on delete restrict,
  operating_workspace_link_id uuid not null,
  resource_type text not null check (resource_type in ('connected_account')),
  native_resource_type text not null check (native_resource_type in ('connected_account')),
  native_resource_id uuid not null,
  capability_key text not null check (capability_key in ('customer_inbox_response')),
  status text not null default 'verified' check (status in ('verified', 'revoked')),
  verification_method text not null check (verification_method in ('verified_operating_workspace_owner')),
  verified_by_operator_id bigint not null,
  source_system text not null,
  source_id text not null,
  provenance_metadata jsonb not null default '{}'::jsonb,
  verified_at timestamptz not null,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, relationship_id, source_system, source_id),
  unique (operating_workspace_id, native_resource_id, capability_key),
  foreign key (workspace_id, relationship_id, operating_workspace_id, operating_workspace_link_id)
    references public.caye_relationship_operating_workspaces(workspace_id, relationship_id, operating_workspace_id, id) on delete restrict,
  foreign key (operating_workspace_id, native_resource_id)
    references public.connected_accounts(user_id, id) on delete restrict,
  foreign key (operating_workspace_id, verified_by_operator_id)
    references public.operator_allowlist(workspace_id, id) on delete restrict,
  check ((status = 'revoked') = (revoked_at is not null))
);

create index caye_relationship_resources_ready_idx
  on public.caye_relationship_resources (workspace_id, relationship_id, capability_key)
  where status = 'verified';

comment on table public.caye_relationship_resources is
  'Verified relationship authority over a native operating resource. It intentionally stores no token, credential, or connector configuration.';

alter table public.caye_commercial_engagements enable row level security;
alter table public.caye_relationship_operating_workspaces enable row level security;
alter table public.caye_relationship_resources enable row level security;

-- Returns the one deterministic Phase 4A readiness outcome. It is a private
-- helper for the service-only RPCs below, not an application-facing API.
create or replace function public.caye_phase4a_job_readiness(
  p_workspace_id uuid, p_job_id uuid, p_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_job public.caye_jobs%rowtype; v_relationship_state text; v_relationship_id uuid;
begin
  -- Every readiness transition takes the relationship lock before its job
  -- lock. Resource revocation takes the same relationship lock before it
  -- changes resource state or scans jobs, so a new job cannot become ready
  -- from a pre-revocation snapshot after revocation commits.
  select r.id into v_relationship_id
    from public.caye_jobs j join public.caye_relationships r
      on r.id = j.relationship_id and r.workspace_id = j.workspace_id
    where j.id = p_job_id and j.workspace_id = p_workspace_id for update of r;
  if not found then raise exception 'job is not in workspace'; end if;
  select * into v_job from public.caye_jobs
    where id = p_job_id and workspace_id = p_workspace_id and relationship_id = v_relationship_id
    for update;
  if not found then raise exception 'job relationship changed during readiness evaluation'; end if;
  select relationship_state into v_relationship_state
    from public.caye_relationships
    where id = v_relationship_id and workspace_id = p_workspace_id;
  if v_job.status not in ('authorized', 'blocked', 'ready') then
    return jsonb_build_object('ready', false, 'preserve_status', true);
  end if;
  if v_relationship_state <> 'client' or not exists (
    select 1 from public.caye_commercial_engagements e
      where e.workspace_id = p_workspace_id and e.relationship_id = v_job.relationship_id
        and e.status in ('paid', 'active')
  ) then return jsonb_build_object('ready', false, 'blocker_key', 'relationship_not_client', 'description', 'Record a canonical paid commercial engagement before Caye can begin.'); end if;
  if not exists (
    select 1 from public.caye_relationship_operating_workspaces ow
      where ow.workspace_id = p_workspace_id and ow.relationship_id = v_job.relationship_id and ow.status = 'active'
  ) then return jsonb_build_object('ready', false, 'blocker_key', 'missing_operating_workspace', 'description', 'Attach a verified operating workspace before Caye can begin.'); end if;
  if not exists (
    select 1 from public.caye_relationship_resources rr
      join public.connected_accounts ca on ca.id = rr.native_resource_id and ca.user_id = rr.operating_workspace_id
      where rr.workspace_id = p_workspace_id and rr.relationship_id = v_job.relationship_id
        and rr.capability_key = 'customer_inbox_response' and rr.status = 'verified'
        and ca.is_active = true and coalesce(ca.needs_reauth, false) = false
  ) then return jsonb_build_object('ready', false, 'blocker_key', 'missing_relationship_operating_resource', 'description', 'Attach a verified relationship-owned operating resource before Caye can begin.'); end if;
  if not exists (
    select 1 from public.caye_authorizations a join public.caye_work_opportunities o on o.id = v_job.opportunity_id
      where a.id = v_job.authorization_id and a.workspace_id = p_workspace_id and a.relationship_id = v_job.relationship_id
        and a.status = 'active' and a.capability_key = 'customer_inbox_response' and a.scope_subject_key = o.subject_key
        and (a.expires_at is null or a.expires_at > p_at)
  ) then return jsonb_build_object('ready', false, 'blocker_key', 'authorization_inactive', 'description', 'The authorization covering this job is no longer active.'); end if;
  return jsonb_build_object('ready', true);
end;
$$;

create or replace function public.caye_record_commercial_engagement(
  p_workspace_id uuid, p_relationship_id uuid, p_engagement_type text, p_status text,
  p_source_system text, p_source_id text, p_idempotency_key text, p_started_at timestamptz,
  p_terms_reference text default null, p_amount numeric default null, p_currency text default null,
  p_provenance_metadata jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_state text;
begin
  if p_status not in ('paid', 'active') then raise exception 'only paid or active commercial engagements can be recorded'; end if;
  select relationship_state into v_state from public.caye_relationships
    where id = p_relationship_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'relationship is not in workspace'; end if;
  insert into public.caye_commercial_engagements (workspace_id, relationship_id, engagement_type, status, source_system, source_id, idempotency_key, started_at, terms_reference, amount, currency, relationship_state_before, provenance_metadata)
    values (p_workspace_id, p_relationship_id, p_engagement_type, p_status, p_source_system, p_source_id, p_idempotency_key, p_started_at, p_terms_reference, p_amount, p_currency, v_state, coalesce(p_provenance_metadata, '{}'::jsonb))
    on conflict (workspace_id, source_system, source_id) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.caye_commercial_engagements
      where workspace_id = p_workspace_id and source_system = p_source_system and source_id = p_source_id
        and relationship_id = p_relationship_id
      for update;
    if not found then raise exception 'commercial engagement idempotency key conflicts with another source event'; end if;
    return v_id;
  end if;
  insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
    values (p_workspace_id, p_started_at, 'commercial_engagement_created', 'caye', 'caye_commercial_engagements', v_id::text, jsonb_build_object('engagement_type', p_engagement_type, 'source_system', p_source_system), 'app');
  if v_state <> 'client' then
    update public.caye_relationships set relationship_state = 'client', updated_at = now() where id = p_relationship_id and workspace_id = p_workspace_id;
    insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
      values (p_workspace_id, p_started_at, 'relationship_became_client', 'caye', 'caye_relationships', p_relationship_id::text, jsonb_build_object('previous_state', v_state, 'commercial_engagement_id', v_id), 'app');
  end if;
  return v_id;
end;
$$;

create or replace function public.caye_link_relationship_operating_workspace(
  p_workspace_id uuid, p_relationship_id uuid, p_operating_workspace_id uuid, p_verified_by_operator_id bigint,
  p_source_system text, p_source_id text, p_verified_at timestamptz, p_provenance_metadata jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform 1 from public.caye_relationships where id = p_relationship_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'relationship is not in workspace'; end if;
  perform 1 from public.operator_allowlist where id = p_verified_by_operator_id and workspace_id = p_operating_workspace_id and role in ('owner', 'founder');
  if not found then raise exception 'verifier is not a verified owner or founder of the operating workspace'; end if;
  insert into public.caye_relationship_operating_workspaces (workspace_id, relationship_id, operating_workspace_id, verification_method, verified_by_operator_id, source_system, source_id, verified_at, provenance_metadata)
    values (p_workspace_id, p_relationship_id, p_operating_workspace_id, 'verified_operating_workspace_owner', p_verified_by_operator_id, p_source_system, p_source_id, p_verified_at, coalesce(p_provenance_metadata, '{}'::jsonb))
    on conflict (workspace_id, relationship_id, operating_workspace_id) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.caye_relationship_operating_workspaces
      where workspace_id = p_workspace_id and relationship_id = p_relationship_id and operating_workspace_id = p_operating_workspace_id
      for update;
    if not found then raise exception 'operating workspace source event conflicts with another relationship mapping'; end if;
    return v_id;
  end if;
  insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
    values (p_workspace_id, p_verified_at, 'relationship_operating_workspace_linked', 'caye', 'caye_relationship_operating_workspaces', v_id::text, jsonb_build_object('operating_workspace_id', p_operating_workspace_id), 'app');
  return v_id;
end;
$$;

create or replace function public.caye_verify_relationship_resource(
  p_workspace_id uuid, p_relationship_id uuid, p_operating_workspace_id uuid, p_operating_workspace_link_id uuid,
  p_native_resource_id uuid, p_verified_by_operator_id bigint, p_source_system text, p_source_id text,
  p_verified_at timestamptz, p_provenance_metadata jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform 1 from public.caye_relationship_operating_workspaces where id = p_operating_workspace_link_id and workspace_id = p_workspace_id and relationship_id = p_relationship_id and operating_workspace_id = p_operating_workspace_id and status = 'active' for update;
  if not found then raise exception 'operating workspace link is not active for relationship'; end if;
  perform 1 from public.operator_allowlist where id = p_verified_by_operator_id and workspace_id = p_operating_workspace_id and role in ('owner', 'founder');
  if not found then raise exception 'verifier is not a verified owner or founder of the operating workspace'; end if;
  perform 1 from public.connected_accounts where id = p_native_resource_id and user_id = p_operating_workspace_id and is_active = true and coalesce(needs_reauth, false) = false for key share;
  if not found then raise exception 'connected account is not an active operating-workspace resource'; end if;
  insert into public.caye_relationship_resources (workspace_id, relationship_id, operating_workspace_id, operating_workspace_link_id, resource_type, native_resource_type, native_resource_id, capability_key, verification_method, verified_by_operator_id, source_system, source_id, verified_at, provenance_metadata)
    values (p_workspace_id, p_relationship_id, p_operating_workspace_id, p_operating_workspace_link_id, 'connected_account', 'connected_account', p_native_resource_id, 'customer_inbox_response', 'verified_operating_workspace_owner', p_verified_by_operator_id, p_source_system, p_source_id, p_verified_at, coalesce(p_provenance_metadata, '{}'::jsonb))
    on conflict (operating_workspace_id, native_resource_id, capability_key) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.caye_relationship_resources
      where operating_workspace_id = p_operating_workspace_id and native_resource_id = p_native_resource_id
        and capability_key = 'customer_inbox_response' and workspace_id = p_workspace_id and relationship_id = p_relationship_id
      for update;
    if not found then raise exception 'resource is already linked to another relationship'; end if;
    return v_id;
  end if;
  insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
    values (p_workspace_id, p_verified_at, 'relationship_resource_verified', 'caye', 'caye_relationship_resources', v_id::text, jsonb_build_object('capability_key', 'customer_inbox_response', 'operating_workspace_id', p_operating_workspace_id), 'app');
  return v_id;
end;
$$;

create or replace function public.caye_reevaluate_job(p_workspace_id uuid, p_job_id uuid, p_at timestamptz)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_readiness jsonb; v_changed boolean := false; v_ready boolean;
begin
  v_readiness := public.caye_phase4a_job_readiness(p_workspace_id, p_job_id, p_at);
  if coalesce((v_readiness ->> 'preserve_status')::boolean, false) then return false; end if;
  v_ready := coalesce((v_readiness ->> 'ready')::boolean, false);
  if v_ready then
    update public.caye_jobs set status = 'ready', blocker_key = null, blocker_description = null, blocker_metadata = '{}'::jsonb, ready_at = coalesce(ready_at, p_at), updated_at = now()
      where id = p_job_id and workspace_id = p_workspace_id and status in ('authorized', 'blocked') returning true into v_changed;
  else
    update public.caye_jobs set status = 'blocked', blocker_key = v_readiness ->> 'blocker_key', blocker_description = v_readiness ->> 'description', blocker_metadata = jsonb_build_object('relationship_id', relationship_id, 'required', v_readiness ->> 'blocker_key'), blocked_at = coalesce(blocked_at, p_at), updated_at = now()
      where id = p_job_id and workspace_id = p_workspace_id and (status = 'authorized' or status = 'ready' or blocker_key is distinct from (v_readiness ->> 'blocker_key')) returning true into v_changed;
  end if;
  if coalesce(v_changed, false) then
    insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
      values (p_workspace_id, p_at, case when v_ready then 'job_ready' else 'job_blocked' end, 'caye', 'caye_jobs', p_job_id::text, case when v_ready then jsonb_build_object('previous_state', 'blocked') else jsonb_build_object('blocker_key', v_readiness ->> 'blocker_key') end, 'app');
  end if;
  return coalesce(v_changed, false);
end;
$$;

create or replace function public.caye_revoke_relationship_resource(
  p_workspace_id uuid, p_resource_id uuid, p_revoked_at timestamptz, p_reason text default null
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_relationship_id uuid; v_changed boolean := false; v_job_id uuid;
begin
  select relationship_id into v_relationship_id
    from public.caye_relationship_resources
    where id = p_resource_id and workspace_id = p_workspace_id and status = 'verified'
    for update;
  if not found then return false; end if;
  -- Match readiness evaluation's relationship-before-job lock boundary before
  -- changing resource state or taking the eligible-job snapshot.
  perform 1 from public.caye_relationships
    where id = v_relationship_id and workspace_id = p_workspace_id
    for update;
  if not found then raise exception 'relationship is not in workspace'; end if;
  update public.caye_relationship_resources set status = 'revoked', revoked_at = p_revoked_at, revocation_reason = p_reason
    where id = p_resource_id and workspace_id = p_workspace_id and status = 'verified';
  if not found then return false; end if;
  v_changed := true;
  insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
    values (p_workspace_id, p_revoked_at, 'relationship_resource_revoked', 'caye', 'caye_relationship_resources', p_resource_id::text, jsonb_strip_nulls(jsonb_build_object('reason', p_reason)), 'app');
  for v_job_id in select id from public.caye_jobs where workspace_id = p_workspace_id and relationship_id = v_relationship_id and status in ('authorized', 'blocked', 'ready') loop
    perform public.caye_reevaluate_job(p_workspace_id, v_job_id, p_revoked_at);
  end loop;
  return v_changed;
end;
$$;

-- Replaces the Phase 3 creation-time placeholder with the same Phase 4A
-- evaluator. It still only creates ready/blocked jobs; it cannot execute one.
create or replace function public.caye_create_authorized_job(
  p_workspace_id uuid, p_relationship_id uuid, p_opportunity_id uuid, p_authorization_id uuid,
  p_owning_capability text, p_job_key text, p_work_type text, p_objective text,
  p_primary_subject_ref text, p_at timestamptz
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_job_id uuid; v_subject_key text; v_authority_type text;
begin
  select subject_key into v_subject_key from public.caye_work_opportunities where id = p_opportunity_id and workspace_id = p_workspace_id and relationship_id = p_relationship_id;
  if not found then raise exception 'opportunity is not in relationship workspace'; end if;
  select authority_type into v_authority_type from public.caye_authorizations where id = p_authorization_id and workspace_id = p_workspace_id and relationship_id = p_relationship_id and status = 'active' and capability_key = 'customer_inbox_response' and scope_subject_key = v_subject_key and (expires_at is null or expires_at > p_at) and (authority_type <> 'one_time' or opportunity_id = p_opportunity_id) for update;
  if not found then raise exception 'authorization does not cover this job'; end if;
  if p_owning_capability <> 'front_desk' or p_work_type <> 'bounded' then raise exception 'Phase 3 supports only bounded front_desk customer inquiry jobs'; end if;
  if v_authority_type = 'one_time' then select id into v_job_id from public.caye_jobs where workspace_id = p_workspace_id and authorization_id = p_authorization_id for update; if v_job_id is not null then return v_job_id; end if; end if;
  insert into public.caye_jobs (workspace_id, relationship_id, opportunity_id, authorization_id, owning_capability, job_key, work_type, objective, primary_subject_ref, status, blocker_key, blocker_description, blocker_metadata, authorized_at)
    values (p_workspace_id, p_relationship_id, p_opportunity_id, p_authorization_id, p_owning_capability, p_job_key, p_work_type, p_objective, p_primary_subject_ref, 'authorized', null, null, '{}'::jsonb, p_at)
    on conflict (workspace_id, authorization_id, opportunity_id, owning_capability, job_key) do nothing returning id into v_job_id;
  if v_job_id is null then select id into v_job_id from public.caye_jobs where workspace_id = p_workspace_id and authorization_id = p_authorization_id and opportunity_id = p_opportunity_id and owning_capability = p_owning_capability and job_key = p_job_key for update; return v_job_id; end if;
  insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin) values (p_workspace_id, p_at, 'job_created', 'caye', 'caye_jobs', v_job_id::text, jsonb_build_object('work_type', p_work_type, 'owning_capability', p_owning_capability), 'app');
  perform public.caye_reevaluate_job(p_workspace_id, v_job_id, p_at);
  return v_job_id;
end;
$$;

revoke all on function public.caye_phase4a_job_readiness(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.caye_record_commercial_engagement(uuid, uuid, text, text, text, text, text, timestamptz, text, numeric, text, jsonb) from public, anon, authenticated;
revoke all on function public.caye_link_relationship_operating_workspace(uuid, uuid, uuid, bigint, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.caye_verify_relationship_resource(uuid, uuid, uuid, uuid, uuid, bigint, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.caye_revoke_relationship_resource(uuid, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.caye_reevaluate_job(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.caye_create_authorized_job(uuid, uuid, uuid, uuid, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.caye_record_commercial_engagement(uuid, uuid, text, text, text, text, text, timestamptz, text, numeric, text, jsonb) to service_role;
grant execute on function public.caye_link_relationship_operating_workspace(uuid, uuid, uuid, bigint, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.caye_verify_relationship_resource(uuid, uuid, uuid, uuid, uuid, bigint, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.caye_revoke_relationship_resource(uuid, uuid, timestamptz, text) to service_role;
grant execute on function public.caye_reevaluate_job(uuid, uuid, timestamptz) to service_role;
grant execute on function public.caye_create_authorized_job(uuid, uuid, uuid, uuid, text, text, text, text, text, timestamptz) to service_role;
