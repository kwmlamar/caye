-- Rolling-deploy compatibility for callers merged before the full ledger schema.
-- The database may derive only metadata from already-present independent evidence;
-- it never invents observation evidence or a VERIFIED status.

create or replace function public.caye_guard_effect_verification_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.workspace_id is distinct from old.workspace_id then
      raise exception 'effect verification workspace is immutable' using errcode = '42501';
    end if;
    if new.idempotency_key is distinct from old.idempotency_key then
      raise exception 'effect verification idempotency key is immutable' using errcode = '22023';
    end if;
    if old.verification_status = 'VERIFIED' and new.verification_status <> 'VERIFIED' then
      raise exception 'verified effect cannot be downgraded in place; write a new reconciliation effect' using errcode = '22023';
    end if;
  end if;

  if new.verification_status = 'INDETERMINATE' and new.ambiguity_reason is null then
    new.ambiguity_reason := coalesce(new.observation_error, new.execution_error, new.verification_reason, 'Outcome is ambiguous');
  end if;

  if new.verification_status = 'VERIFIED' then
    if new.observation_source is null
       or new.observed_at is null
       or new.observed_state is null
       or new.observation_error is not null
       or new.executed_at is null
       or new.observed_at < new.executed_at then
      raise exception 'VERIFIED requires independent post-execution observation evidence' using errcode = '23514';
    end if;
    if new.verification_confidence = 0 then
      new.verification_confidence := 1;
    end if;
    if new.verified_at is null then
      new.verified_at := new.observed_at;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.caye_guard_effect_verification_transition() from public, anon, authenticated;
grant execute on function public.caye_guard_effect_verification_transition() to service_role;

drop trigger if exists trg_caye_effect_verification_transition on public.caye_effect_verifications;
create trigger trg_caye_effect_verification_transition
before insert or update on public.caye_effect_verifications
for each row execute function public.caye_guard_effect_verification_transition();
