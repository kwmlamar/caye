-- GitHub #216: a real browser submission consumes a slot before the click.
-- This is deliberately a small service-role-only RPC instead of a read/count
-- in application code: concurrent workers must not turn a cap of 3 into 4.
create table if not exists public.job_search_submission_reservations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.job_search_applications(id) on delete cascade,
  reservation_day date not null default (timezone('utc', now()))::date,
  claim_token uuid not null,
  created_at timestamptz not null default now()
);

create unique index if not exists job_search_submission_reservations_day_application_idx
  on public.job_search_submission_reservations (reservation_day, application_id);
create index if not exists job_search_submission_reservations_day_idx
  on public.job_search_submission_reservations (reservation_day);
alter table public.job_search_submission_reservations enable row level security;

create or replace function public.reserve_job_search_submission_slot(p_application_id uuid, p_claim_token uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cap integer;
  v_used integer;
  v_day date := (timezone('utc', now()))::date;
begin
  -- The application claim is part of the reservation identity. A stale worker
  -- cannot reserve capacity for a newer claimant.
  if not exists (
    select 1 from public.job_search_applications
    where id = p_application_id and status = 'APPLYING' and execution_claim_token = p_claim_token
  ) then return false; end if;

  select daily_submission_cap into v_cap from public.job_search_execution_settings where id = true for update;
  if v_cap is null then return false; end if;
  perform pg_advisory_xact_lock(hashtext('job_search_submission_cap:' || v_day::text));
  select count(*) into v_used from public.job_search_submission_reservations where reservation_day = v_day;
  if v_used >= v_cap then return false; end if;
  insert into public.job_search_submission_reservations(application_id, reservation_day, claim_token)
  values (p_application_id, v_day, p_claim_token)
  on conflict (application_id) do nothing;
  return found;
end;
$$;

revoke all on function public.reserve_job_search_submission_slot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_job_search_submission_slot(uuid, uuid) to service_role;
