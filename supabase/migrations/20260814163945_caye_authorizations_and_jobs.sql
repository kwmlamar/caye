-- Phase 3: durable permission, commitment, and prerequisite state. This stops
-- before execution: native capabilities remain authoritative for actual work.
-- DEPLOYMENT ORDER: apply this migration before application code calls these RPCs.

create unique index if not exists operator_allowlist_workspace_id_id_unique_idx
  on public.operator_allowlist (workspace_id, id);

create table public.caye_authorizations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  relationship_id uuid not null,
  opportunity_id uuid,
  -- An authorizer is either a verified workspace operator or the existing
  -- canonical contact for this relationship. These identities are deliberately
  -- not interchangeable: a prospect never becomes a workspace operator.
  authorizer_kind text not null
    check (authorizer_kind in ('workspace_operator', 'external_representative')),
  authorizer_verification text not null
    check (authorizer_verification in ('workspace_owner_founder', 'direct_relationship_contact_reply')),
  authorized_by_operator_id bigint,
  authorized_by_contact_id uuid,
  source_channel text not null,
  source_type text not null,
  source_id text not null,
  authority_type text not null check (authority_type in ('one_time', 'standing', 'mandate')),
  status text not null default 'active' check (status in ('active', 'revoked', 'expired', 'superseded')),
  capability_key text not null,
  -- Deterministic matching data. Prose explains the grant; it is not the
  -- matcher. A standing grant may govern many future matching opportunities.
  scope_subject_key text not null,
  scope_description text not null,
  scope_metadata jsonb not null default '{}'::jsonb,
  authorized_at timestamptz not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by_operator_id bigint,
  revocation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_type, source_id, capability_key, scope_subject_key),
  foreign key (workspace_id, relationship_id)
    references public.caye_relationships(workspace_id, id) on delete restrict,
  foreign key (workspace_id, opportunity_id)
    references public.caye_work_opportunities(workspace_id, id) on delete restrict,
  foreign key (workspace_id, authorized_by_operator_id)
    references public.operator_allowlist(workspace_id, id) on delete restrict,
  foreign key (workspace_id, authorized_by_contact_id)
    references public.contacts(customer_id, id) on delete restrict,
  foreign key (workspace_id, revoked_by_operator_id)
    references public.operator_allowlist(workspace_id, id) on delete restrict,
  check (expires_at is null or expires_at > authorized_at),
  check ((status = 'active' and revoked_at is null) or status <> 'active'),
  check (
    (authorizer_kind = 'workspace_operator'
      and authorizer_verification = 'workspace_owner_founder'
      and authorized_by_operator_id is not null and authorized_by_contact_id is null)
    or
    (authorizer_kind = 'external_representative'
      and authorizer_verification = 'direct_relationship_contact_reply'
      and authorized_by_operator_id is null and authorized_by_contact_id is not null)
  )
);

create index caye_authorizations_active_match_idx
  on public.caye_authorizations (workspace_id, capability_key, scope_subject_key, expires_at)
  where status = 'active';

comment on table public.caye_authorizations is
  'Durable, provenance-backed business permission. Authorizers are either verified workspace operators or narrowly verified relationship contacts; it is distinct from access, jobs, and high-risk action approval.';

create table public.caye_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  relationship_id uuid not null,
  opportunity_id uuid not null,
  authorization_id uuid not null,
  owning_capability text not null,
  -- Stable instance identity. A standing authorization can govern later
  -- distinct jobs without turning generated objective prose into identity.
  job_key text not null,
  work_type text not null check (work_type in ('bounded', 'recurring', 'continuous')),
  objective text not null,
  primary_subject_ref text,
  status text not null default 'authorized'
    check (status in ('authorized', 'ready', 'blocked', 'active', 'completed', 'failed', 'cancelled')),
  blocker_key text,
  blocker_description text,
  blocker_metadata jsonb not null default '{}'::jsonb,
  authorized_at timestamptz not null,
  ready_at timestamptz,
  active_at timestamptz,
  blocked_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, authorization_id, opportunity_id, owning_capability, job_key),
  foreign key (workspace_id, relationship_id)
    references public.caye_relationships(workspace_id, id) on delete restrict,
  foreign key (workspace_id, opportunity_id)
    references public.caye_work_opportunities(workspace_id, id) on delete restrict,
  foreign key (workspace_id, authorization_id)
    references public.caye_authorizations(workspace_id, id) on delete restrict,
  check ((status = 'blocked') = (blocker_key is not null)),
  check (blocker_key is null or blocker_description is not null)
);

create index caye_jobs_workspace_status_idx
  on public.caye_jobs (workspace_id, status, updated_at desc);

comment on table public.caye_jobs is
  'Caye coordination commitment under valid authorization. Phase 3 never executes it; native capabilities own execution truth in later phases.';

alter table public.caye_authorizations enable row level security;
alter table public.caye_jobs enable row level security;

create or replace function public.caye_create_authorization(
  p_workspace_id uuid, p_relationship_id uuid, p_opportunity_id uuid,
  p_authorizer_kind text, p_authorized_by_operator_id bigint, p_authorized_by_contact_id uuid,
  p_source_channel text, p_source_type text, p_source_id text, p_authority_type text, p_capability_key text,
  p_scope_subject_key text, p_scope_description text, p_scope_metadata jsonb,
  p_authorized_at timestamptz, p_expires_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_authorization_id uuid;
begin
  perform 1 from public.caye_relationships
    where id = p_relationship_id and workspace_id = p_workspace_id;
  if not found then raise exception 'relationship is not in workspace'; end if;
  perform 1 from public.caye_work_opportunities
    where id = p_opportunity_id and workspace_id = p_workspace_id and relationship_id = p_relationship_id;
  if not found then raise exception 'opportunity is not in relationship workspace'; end if;
  if p_authorizer_kind = 'workspace_operator' then
    perform 1 from public.operator_allowlist
      where id = p_authorized_by_operator_id and workspace_id = p_workspace_id
        and role in ('owner', 'founder');
    if not found or p_authorized_by_contact_id is not null then
      raise exception 'authorizer is not a verified owner or founder in workspace';
    end if;
  elsif p_authorizer_kind = 'external_representative' then
    -- The source must be the contact's actual inbound message on the same
    -- relationship. A reply alone is not broad authority: this path is only
    -- the finite Phase 3 proof-of-value grant validated below.
    perform 1
      from public.caye_relationships r
      join public.unified_conversations c on c.contact_id = r.contact_id
      join public.unified_messages m on m.conversation_id = c.id
      join public.connected_accounts ca on ca.id = c.connected_account_id
      where r.id = p_relationship_id and r.workspace_id = p_workspace_id
        and r.contact_id = p_authorized_by_contact_id
        and ca.user_id = p_workspace_id and m.id::text = p_source_id
        and m.sender_type = 'customer'
        and m.content ~* '(yes|yeah|please|go ahead)[,.![:space:]]+(you can )?(handle|answer|respond to)[[:space:]]+(the |my )?(next )?[0-9]{1,2}[[:space:]]+(customer )?(inquiries|enquiries|messages)';
    if not found or p_authorized_by_operator_id is not null or p_source_type <> 'unified_message' then
      raise exception 'authorizer is not a verified direct relationship contact reply';
    end if;
    if p_authority_type <> 'one_time' or p_capability_key <> 'customer_inbox_response'
      or p_scope_subject_key <> 'customer_inquiry_response'
      or coalesce(p_scope_metadata ->> 'max_inquiries', '') !~ '^(?:[1-9]|1[0-9]|2[0-5])$' then
      raise exception 'direct relationship contact replies may authorize only bounded customer inquiry work';
    end if;
  else
    raise exception 'unsupported authorizer kind';
  end if;
  if p_authority_type not in ('one_time', 'standing', 'mandate') then
    raise exception 'unsupported authority type';
  end if;
  insert into public.caye_authorizations (
    workspace_id, relationship_id, opportunity_id, authorizer_kind, authorizer_verification,
    authorized_by_operator_id, authorized_by_contact_id,
    source_channel, source_type, source_id, authority_type, capability_key,
    scope_subject_key, scope_description, scope_metadata, authorized_at, expires_at
  ) values (
    p_workspace_id, p_relationship_id, p_opportunity_id, p_authorizer_kind,
    case when p_authorizer_kind = 'workspace_operator' then 'workspace_owner_founder' else 'direct_relationship_contact_reply' end,
    p_authorized_by_operator_id, p_authorized_by_contact_id,
    p_source_channel, p_source_type, p_source_id, p_authority_type, p_capability_key,
    p_scope_subject_key, p_scope_description, coalesce(p_scope_metadata, '{}'::jsonb),
    p_authorized_at, p_expires_at
  ) on conflict (workspace_id, source_type, source_id, capability_key, scope_subject_key)
  do nothing returning id into v_authorization_id;
  if v_authorization_id is null then
    select id into v_authorization_id from public.caye_authorizations
      where workspace_id = p_workspace_id and source_type = p_source_type and source_id = p_source_id
        and capability_key = p_capability_key and scope_subject_key = p_scope_subject_key
      for update;
    return v_authorization_id;
  end if;
  insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
    values (p_workspace_id, p_authorized_at, 'authorization_created', 'caye', 'caye_authorizations', v_authorization_id::text,
      jsonb_build_object('authority_type', p_authority_type, 'authorizer_kind', p_authorizer_kind,
        'capability_key', p_capability_key, 'scope_subject_key', p_scope_subject_key), 'app');
  return v_authorization_id;
end;
$$;

create or replace function public.caye_revoke_authorization(
  p_workspace_id uuid, p_authorization_id uuid, p_revoked_by_operator_id bigint,
  p_revoked_at timestamptz, p_reason text default null
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare changed boolean := false; v_cancelled_job_ids uuid[] := '{}';
begin
  perform 1 from public.operator_allowlist
    where id = p_revoked_by_operator_id and workspace_id = p_workspace_id and role in ('owner', 'founder');
  if not found then raise exception 'revoker is not a verified owner or founder in workspace'; end if;
  update public.caye_authorizations set status = 'revoked', revoked_at = p_revoked_at,
    revoked_by_operator_id = p_revoked_by_operator_id, revocation_reason = p_reason, updated_at = now()
    where id = p_authorization_id and workspace_id = p_workspace_id and status = 'active'
    returning true into changed;
  if not coalesce(changed, false) then return false; end if;
  insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
    values (p_workspace_id, p_revoked_at, 'authorization_revoked', 'caye', 'caye_authorizations', p_authorization_id::text,
      jsonb_strip_nulls(jsonb_build_object('reason', p_reason)), 'app');
  with cancelled as (
    update public.caye_jobs set status = 'cancelled', cancelled_at = p_revoked_at,
      cancellation_reason = 'authorization_revoked', updated_at = now()
      where workspace_id = p_workspace_id and authorization_id = p_authorization_id
        and status in ('authorized', 'ready', 'blocked')
      returning id
  ) select coalesce(array_agg(id), '{}') into v_cancelled_job_ids from cancelled;
  insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
    select workspace_id, p_revoked_at, 'job_cancelled', 'caye', 'caye_jobs', id::text,
      jsonb_build_object('reason', 'authorization_revoked'), 'app'
    from public.caye_jobs where id = any(v_cancelled_job_ids);
  return true;
end;
$$;

create or replace function public.caye_create_authorized_job(
  p_workspace_id uuid, p_relationship_id uuid, p_opportunity_id uuid,
  p_authorization_id uuid, p_owning_capability text, p_job_key text, p_work_type text,
  p_objective text, p_primary_subject_ref text, p_at timestamptz
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_job_id uuid; v_has_channel boolean; v_subject_key text; v_authority_type text; v_relationship_state text;
begin
  select subject_key into v_subject_key from public.caye_work_opportunities
    where id = p_opportunity_id and workspace_id = p_workspace_id and relationship_id = p_relationship_id;
  if not found then raise exception 'opportunity is not in relationship workspace'; end if;
  select authority_type into v_authority_type from public.caye_authorizations
    where id = p_authorization_id and workspace_id = p_workspace_id and relationship_id = p_relationship_id
      and status = 'active' and capability_key = 'customer_inbox_response'
      and scope_subject_key = v_subject_key and (expires_at is null or expires_at > p_at)
      and (authority_type <> 'one_time' or opportunity_id = p_opportunity_id)
    for update;
  if not found then raise exception 'authorization does not cover this job'; end if;
  if p_owning_capability <> 'front_desk' or p_work_type <> 'bounded' then
    raise exception 'Phase 3 supports only bounded front_desk customer inquiry jobs';
  end if;
  if v_authority_type = 'one_time' then
    select id into v_job_id from public.caye_jobs
      where workspace_id = p_workspace_id and authorization_id = p_authorization_id
      for update;
    if v_job_id is not null then return v_job_id; end if;
  end if;
  select relationship_state into v_relationship_state from public.caye_relationships
    where id = p_relationship_id and workspace_id = p_workspace_id;
  -- No current model proves that a workspace account is the operating
  -- resource for a particular relationship. `client` is commercial state,
  -- not that proof. Until a future relationship-owned access link exists,
  -- every job remains blocked rather than borrowing any workspace account.
  v_has_channel := false;
  insert into public.caye_jobs (workspace_id, relationship_id, opportunity_id, authorization_id,
    owning_capability, job_key, work_type, objective, primary_subject_ref, status, blocker_key,
    blocker_description, blocker_metadata, authorized_at)
  values (p_workspace_id, p_relationship_id, p_opportunity_id, p_authorization_id,
    p_owning_capability, p_job_key, p_work_type, p_objective, p_primary_subject_ref,
    case when v_has_channel then 'ready' else 'blocked' end,
    case when v_has_channel then null when v_relationship_state = 'client' then 'missing_relationship_operating_resource' else 'missing_counterparty_communication_access' end,
    case when v_has_channel then null when v_relationship_state = 'client' then 'Attach a verified relationship-owned operating resource before Caye can begin.' else 'Attach counterparty-authorized communication access before Caye can begin.' end,
    case when v_has_channel then '{}'::jsonb when v_relationship_state = 'client' then jsonb_build_object('required', 'verified_relationship_operating_resource', 'relationship_id', p_relationship_id) else jsonb_build_object('required', 'counterparty_authorized_communication_access', 'relationship_id', p_relationship_id) end,
    p_at)
  on conflict (workspace_id, authorization_id, opportunity_id, owning_capability, job_key)
  do nothing returning id into v_job_id;
  if v_job_id is null then
    select id into v_job_id from public.caye_jobs where workspace_id = p_workspace_id
      and authorization_id = p_authorization_id and opportunity_id = p_opportunity_id
      and owning_capability = p_owning_capability and job_key = p_job_key for update;
    return v_job_id;
  end if;
  insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
    values (p_workspace_id, p_at, 'job_created', 'caye', 'caye_jobs', v_job_id::text,
      jsonb_build_object('work_type', p_work_type, 'owning_capability', p_owning_capability), 'app');
  insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
    values (p_workspace_id, p_at, case when v_has_channel then 'job_ready' else 'job_blocked' end, 'caye', 'caye_jobs', v_job_id::text,
      case when v_has_channel then '{}'::jsonb when v_relationship_state = 'client' then jsonb_build_object('blocker_key', 'missing_relationship_operating_resource') else jsonb_build_object('blocker_key', 'missing_counterparty_communication_access') end, 'app');
  return v_job_id;
end;
$$;

create or replace function public.caye_reevaluate_job(
  p_workspace_id uuid, p_job_id uuid, p_at timestamptz
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_has_channel boolean; v_changed boolean := false; v_relationship_state text;
begin
  select r.relationship_state into v_relationship_state
    from public.caye_jobs j join public.caye_relationships r on r.id = j.relationship_id and r.workspace_id = j.workspace_id
    where j.id = p_job_id and j.workspace_id = p_workspace_id for update of j, r;
  if not found then raise exception 'job is not in workspace'; end if;
  -- Re-evaluation deliberately cannot borrow a workspace account. Phase 4
  -- must provide verified relationship-owned operating access first.
  v_has_channel := false;
  if v_has_channel then
    update public.caye_jobs set status = 'ready', blocker_key = null, blocker_description = null,
      blocker_metadata = '{}'::jsonb, ready_at = coalesce(ready_at, p_at), updated_at = now()
      where id = p_job_id and workspace_id = p_workspace_id and status = 'blocked'
      returning true into v_changed;
  end if;
  if coalesce(v_changed, false) then
    insert into public.workspace_events (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
      values (p_workspace_id, p_at, 'job_ready', 'caye', 'caye_jobs', p_job_id::text,
        jsonb_build_object('previous_state', 'blocked'), 'app');
  end if;
  return coalesce(v_changed, false);
end;
$$;

revoke all on function public.caye_create_authorization(uuid, uuid, uuid, text, bigint, uuid, text, text, text, text, text, text, text, jsonb, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.caye_revoke_authorization(uuid, uuid, bigint, timestamptz, text) from public, anon, authenticated;
revoke all on function public.caye_create_authorized_job(uuid, uuid, uuid, uuid, text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.caye_reevaluate_job(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.caye_create_authorization(uuid, uuid, uuid, text, bigint, uuid, text, text, text, text, text, text, text, jsonb, timestamptz, timestamptz) to service_role;
grant execute on function public.caye_revoke_authorization(uuid, uuid, bigint, timestamptz, text) to service_role;
grant execute on function public.caye_create_authorized_job(uuid, uuid, uuid, uuid, text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.caye_reevaluate_job(uuid, uuid, timestamptz) to service_role;
