-- Repair the standing research-desk claim RPC. In PL/pgSQL, output parameters
-- desk_id/wakeup_key are variables, so `on conflict (desk_id, wakeup_key)` is
-- ambiguous. Target the concrete unique constraint instead.

create or replace function public.claim_due_research_desk(p_worker text, p_now timestamptz default now())
returns table(desk_id uuid, wakeup_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desk public.research_desks%rowtype;
  v_wakeup text;
begin
  select * into v_desk
  from public.research_desks
  where status = 'active'
    and (next_scheduled_investigation is null or next_scheduled_investigation <= p_now)
  order by next_scheduled_investigation nulls first, created_at
  for update skip locked
  limit 1;

  if v_desk.id is null then return; end if;

  v_wakeup := 'schedule:' || to_char(date_trunc('minute', coalesce(v_desk.next_scheduled_investigation, p_now)), 'YYYYMMDDHH24MI');
  insert into public.research_desk_cycles (desk_id, wakeup_key, status, checkpoint)
  values (v_desk.id, v_wakeup, 'running', jsonb_build_object('claimedBy', p_worker))
  on conflict on constraint research_desk_cycles_desk_id_wakeup_key_key do nothing;

  if not found then return; end if;

  update public.research_desks
  set next_scheduled_investigation = p_now + interval '15 minutes', updated_at = now()
  where id = v_desk.id;

  desk_id := v_desk.id;
  wakeup_key := v_wakeup;
  return next;
end;
$$;

revoke execute on function public.claim_due_research_desk(text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_due_research_desk(text, timestamptz) to service_role;
