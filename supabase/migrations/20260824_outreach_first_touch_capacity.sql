-- Atomic daily first-touch capacity for autonomous Outreach. Counting prior
-- sends in application code is insufficient when two cron workers overlap.
create table public.outreach_daily_first_touch_capacity (
  workspace_id uuid not null references public.customers(id) on delete cascade,
  day date not null,
  reserved_count integer not null default 0 check (reserved_count >= 0),
  primary key (workspace_id, day)
);

create table public.outreach_first_touch_reservations (
  workspace_id uuid not null references public.customers(id) on delete cascade,
  lead_id uuid not null references public.outreach_leads(id) on delete cascade,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, lead_id),
  foreign key (workspace_id, day) references public.outreach_daily_first_touch_capacity(workspace_id, day) on delete cascade
);

alter table public.outreach_daily_first_touch_capacity enable row level security;
alter table public.outreach_first_touch_reservations enable row level security;

create or replace function public.reserve_outreach_first_touch_capacity(
  p_workspace_id uuid, p_lead_id uuid, p_day date, p_cap integer
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_count integer; v_lead public.outreach_leads%rowtype;
begin
  if p_cap < 1 then raise exception 'first-touch cap must be positive'; end if;
  -- Serialize reservations for one workspace/day before looking at its count.
  insert into public.outreach_daily_first_touch_capacity(workspace_id, day)
    values (p_workspace_id, p_day) on conflict do nothing;
  select reserved_count into v_count from public.outreach_daily_first_touch_capacity
    where workspace_id = p_workspace_id and day = p_day for update;
  select * into v_lead from public.outreach_leads
    where id = p_lead_id and workspace_id = p_workspace_id for update;
  if not found or v_lead.opted_out_at is not null or v_lead.first_touch_sent_at is not null
    or v_lead.stage <> 'sourced' then return false; end if;
  if exists (select 1 from public.outreach_first_touch_reservations
    where workspace_id = p_workspace_id and lead_id = p_lead_id) then return true; end if;
  if v_count >= p_cap then return false; end if;
  insert into public.outreach_first_touch_reservations(workspace_id, lead_id, day)
    values (p_workspace_id, p_lead_id, p_day);
  update public.outreach_daily_first_touch_capacity set reserved_count = reserved_count + 1
    where workspace_id = p_workspace_id and day = p_day;
  return true;
end;
$$;

revoke all on function public.reserve_outreach_first_touch_capacity(uuid, uuid, date, integer) from public, anon, authenticated;
grant execute on function public.reserve_outreach_first_touch_capacity(uuid, uuid, date, integer) to service_role;

comment on table public.outreach_first_touch_reservations is
  'Durable pre-dispatch first-touch capacity reservation. Deliberately retained after ambiguous provider/DB failure: spending a slot is recoverable; risking a duplicate external email is not.';
