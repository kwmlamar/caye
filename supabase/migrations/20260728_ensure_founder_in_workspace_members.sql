-- 2026-07-28 — auto-add founder to workspace_members on every new signup
--
-- ensure_founder_in_allowlist (operator_allowlist, see
-- 20260624_operator_allowlist.sql) already grants the founder automatic
-- WhatsApp back-office access to every new workspace, but nothing
-- analogous ever populated workspace_members — the table the founder
-- dashboard's workspace sidebar actually reads (app/dashboard/[workspaceId]
-- /layout.tsx queries workspace_members by session.user_id, not
-- operator_allowlist). Every workspace currently showing there (Bimini,
-- Simply Dave, TropiTech Outreach) got its founder row from a one-off
-- manual insert at setup time, not automation — so any new signup pinged
-- the founder's WhatsApp (notifyFounderOfNewSignup) but never appeared in
-- Caye Command until someone remembered to add it by hand. Confirmed live
-- 2026-07-28: KWM industries test signup did exactly that.
--
-- Mirrors ensure_founder_in_allowlist's shape but keys off founder_email
-- (platform_settings) resolved to an auth.users id, since workspace_members
-- is keyed by Supabase auth user id, not phone. No-op if founder_email is
-- unset or doesn't match an auth user — safe to apply before/without seeding.

create or replace function public.ensure_founder_in_workspace_members()
  returns trigger
  language plpgsql
  security definer
as $$
declare
  fe text;
  fid uuid;
begin
  select value into fe from public.platform_settings where key = 'founder_email';
  if fe is null or length(fe) = 0 then
    return new;
  end if;

  select id into fid from auth.users where email = fe limit 1;
  if fid is null then
    return new;
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
    values (new.id, fid, 'admin')
  on conflict (workspace_id, user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists ensure_founder_in_workspace_members_on_customer on public.customers;
create trigger ensure_founder_in_workspace_members_on_customer
  after insert on public.customers
  for each row execute function public.ensure_founder_in_workspace_members();

-- ── backfill: founder onto every existing workspace missing it ──────────
insert into public.workspace_members (workspace_id, user_id, role)
  select c.id, u.id, 'admin'
  from public.customers c
  cross join (
    select id from auth.users
    where email = (select value from public.platform_settings where key = 'founder_email')
    limit 1
  ) u
  where not exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = c.id and wm.user_id = u.id
  )
on conflict (workspace_id, user_id) do nothing;
