-- CAY-28: authority-aware business decision routing.
-- Extend the existing operator identity + owner-attention primitives rather
-- than introducing a second identity/permissions universe.

alter table public.operator_allowlist
  add column if not exists decision_scopes text[] not null default '{}'::text[];

-- Existing verified workspace owners receive an explicit persisted business
-- authority grant. Founder/platform-support rows intentionally receive none.
update public.operator_allowlist
set decision_scopes = array['business.*', 'routing.*']::text[]
where role = 'owner'
  and verified_at is not null
  and coalesce(array_length(decision_scopes, 1), 0) = 0;

create table if not exists public.operator_authority_delegations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  delegate_operator_id bigint not null references public.operator_allowlist(id) on delete cascade,
  granted_by_operator_id bigint not null references public.operator_allowlist(id) on delete restrict,
  scopes text[] not null check (cardinality(scopes) > 0),
  preferred boolean not null default false,
  valid_from timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or expires_at > valid_from)
);

create index if not exists operator_authority_delegations_workspace_active_idx
  on public.operator_authority_delegations(workspace_id, delegate_operator_id)
  where revoked_at is null;

create or replace function public.caye_validate_operator_authority_workspace()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  delegate_workspace uuid;
  grantor_workspace uuid;
begin
  select workspace_id into delegate_workspace
  from public.operator_allowlist
  where id = new.delegate_operator_id;

  select workspace_id into grantor_workspace
  from public.operator_allowlist
  where id = new.granted_by_operator_id;

  if delegate_workspace is distinct from new.workspace_id
     or grantor_workspace is distinct from new.workspace_id then
    raise exception 'authority delegation operators must belong to the same workspace';
  end if;
  return new;
end;
$$;

drop trigger if exists operator_authority_delegations_workspace_guard
  on public.operator_authority_delegations;
create trigger operator_authority_delegations_workspace_guard
before insert or update on public.operator_authority_delegations
for each row execute function public.caye_validate_operator_authority_workspace();

alter table public.operator_authority_delegations enable row level security;
revoke all on public.operator_authority_delegations from anon, authenticated;

alter table public.caye_owner_attention
  add column if not exists decision_domain text,
  add column if not exists required_authority text,
  add column if not exists decision_risk text,
  add column if not exists decision_owner_operator_id bigint references public.operator_allowlist(id) on delete set null,
  add column if not exists decision_requested_by_operator_id bigint references public.operator_allowlist(id) on delete set null,
  add column if not exists decision_actor_operator_id bigint references public.operator_allowlist(id) on delete set null,
  add column if not exists decision_actor_authority text,
  add column if not exists decision_requested_at timestamptz,
  add column if not exists decision_expires_at timestamptz,
  add column if not exists decision_evidence jsonb not null default '{}'::jsonb,
  add column if not exists decision_resume_link jsonb,
  add column if not exists routing_attempts jsonb not null default '[]'::jsonb;

create index if not exists caye_owner_attention_pending_decision_owner_idx
  on public.caye_owner_attention(workspace_id, decision_owner_operator_id, status)
  where subject_type = 'decision' and decided_at is null;

create or replace function public.caye_validate_attention_decision_workspace()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  owner_workspace uuid;
  requester_workspace uuid;
  actor_workspace uuid;
begin
  if new.decision_owner_operator_id is not null then
    select workspace_id into owner_workspace from public.operator_allowlist where id = new.decision_owner_operator_id;
    if owner_workspace is distinct from new.workspace_id then
      raise exception 'decision owner must belong to attention workspace';
    end if;
  end if;
  if new.decision_requested_by_operator_id is not null then
    select workspace_id into requester_workspace from public.operator_allowlist where id = new.decision_requested_by_operator_id;
    if requester_workspace is distinct from new.workspace_id then
      raise exception 'decision requester must belong to attention workspace';
    end if;
  end if;
  if new.decision_actor_operator_id is not null then
    select workspace_id into actor_workspace from public.operator_allowlist where id = new.decision_actor_operator_id;
    if actor_workspace is distinct from new.workspace_id then
      raise exception 'decision actor must belong to attention workspace';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists caye_owner_attention_decision_workspace_guard
  on public.caye_owner_attention;
create trigger caye_owner_attention_decision_workspace_guard
before insert or update of decision_owner_operator_id, decision_requested_by_operator_id, decision_actor_operator_id, workspace_id
on public.caye_owner_attention
for each row execute function public.caye_validate_attention_decision_workspace();
