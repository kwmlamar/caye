-- Canonical durable effect-verification substrate.
-- Attempted != executed != independently observed != verified.

create table if not exists public.caye_effect_verifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  effect_id text not null,
  effect text not null,
  action_kind text,
  execution_id text,
  objective_id text,
  authority_ref text,
  idempotency_key text not null,
  intended_effect jsonb not null default '{}'::jsonb,
  expected_state jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null,
  attempted_at timestamptz not null,
  execution_status text not null check (execution_status in ('attempted','executed','failed','indeterminate')),
  execution_receipt jsonb not null default '{}'::jsonb,
  execution_error text,
  executed_at timestamptz,
  provider_identity text,
  provider_request_id text,
  provider_external_id text,
  observation_source text,
  observation_provider_identity text,
  observation_provenance_ref text,
  observed_state jsonb,
  observation_error text,
  observed_at timestamptz,
  observation_fresh_until timestamptz,
  verification_status text not null check (verification_status in ('VERIFIED','PARTIAL','FAILED','INDETERMINATE')),
  verification_confidence numeric(4,3) not null default 0 check (verification_confidence >= 0 and verification_confidence <= 1),
  comparison jsonb not null default '[]'::jsonb,
  verification_reason text not null,
  ambiguity_reason text,
  retry_safe boolean not null default false,
  retry_count integer not null default 0 check (retry_count >= 0),
  max_retries integer not null default 3 check (max_retries >= 0),
  next_retry_at timestamptz,
  last_retry_at timestamptz,
  recovery_state text not null default 'none' check (recovery_state in ('none','observe_only','retry_allowed','manual_review','reconciled','abandoned')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  unique (workspace_id, effect_id),
  check (executed_at is null or executed_at >= attempted_at),
  check (observed_at is null or observed_at >= attempted_at),
  check (
    verification_status <> 'VERIFIED'
    or (
      execution_status = 'executed'
      and executed_at is not null
      and observed_at is not null
      and observed_at >= executed_at
      and observed_state is not null
      and observation_source is not null
      and observation_error is null
      and verification_confidence > 0
      and verified_at is not null
      and verified_at = observed_at
    )
  ),
  check (
    verification_status <> 'INDETERMINATE'
    or ambiguity_reason is not null
    or observation_error is not null
    or execution_status = 'indeterminate'
  )
);

create index if not exists caye_effect_verifications_workspace_status_idx
  on public.caye_effect_verifications(workspace_id, verification_status, updated_at desc);
create index if not exists caye_effect_verifications_provider_external_idx
  on public.caye_effect_verifications(provider_identity, provider_external_id)
  where provider_external_id is not null;
create index if not exists caye_effect_verifications_retry_idx
  on public.caye_effect_verifications(recovery_state, next_retry_at)
  where verification_status = 'INDETERMINATE';

alter table public.caye_effect_verifications enable row level security;
revoke all on table public.caye_effect_verifications from public, anon, authenticated;
grant select, insert, update, delete on table public.caye_effect_verifications to service_role;

create or replace function public.caye_guard_effect_verification_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'effect verification workspace is immutable' using errcode = '42501';
  end if;
  if new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'effect verification idempotency key is immutable' using errcode = '22023';
  end if;
  if old.verification_status = 'VERIFIED' and new.verification_status <> 'VERIFIED' then
    raise exception 'verified effect cannot be downgraded in place; write a new reconciliation effect' using errcode = '22023';
  end if;
  if new.verification_status = 'VERIFIED' and (
       new.observation_source is null
       or new.observed_at is null
       or new.observed_state is null
       or new.observation_error is not null
       or new.executed_at is null
       or new.observed_at < new.executed_at
     ) then
    raise exception 'VERIFIED requires independent post-execution observation evidence' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.caye_guard_effect_verification_transition() from public, anon, authenticated;
grant execute on function public.caye_guard_effect_verification_transition() to service_role;

drop trigger if exists trg_caye_effect_verification_transition on public.caye_effect_verifications;
create trigger trg_caye_effect_verification_transition
before update on public.caye_effect_verifications
for each row execute function public.caye_guard_effect_verification_transition();

comment on table public.caye_effect_verifications is
'Canonical durable effect-verification ledger. Provider/executor success is evidence of execution only; VERIFIED requires independent post-execution observation.';
