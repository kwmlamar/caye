-- 2026-06-24 — operator allowlist with roles (#48)
--
-- Replaces the single `operator_whatsapp_number` column on workspace_ai_config
-- with a real table. Same workspace, multiple authorized phones — each with a
-- role. Schema supports:
--   - owner: workspace owner (existing operator_whatsapp_number rows backfilled
--     into this table as 'owner').
--   - staff: future per-workspace staff (schema stub only in v1; no tool wiring).
--   - founder: TropiTech founder (Lamar). Auto-inserted on every workspace via
--     trigger when platform_settings.founder_phone is set. Default-on per
--     CLAUDE.md — not a debug back door, first-class support+observability.
--
-- The webhook (whatsapp-operator) reads from this table to identify both the
-- workspace AND the caller's role. The role is plumbed through cayeAgent →
-- runToolLoop → ToolContext → tool.execute, where the execute path rejects
-- tool invocations whose declared roles[] doesn't include the caller's role.

-- ── platform_settings ────────────────────────────────────────────────────────
-- Tiny key/value table for platform-wide values that don't fit on a single
-- domain table. founder_phone is the first key; future keys may include other
-- platform-wide rotations.
create table if not exists public.platform_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.platform_settings enable row level security;

-- ── operator_allowlist ───────────────────────────────────────────────────────
create table if not exists public.operator_allowlist (
  id bigserial primary key,
  workspace_id uuid not null references public.customers(id) on delete cascade,
  phone text not null,
  role text not null check (role in ('owner', 'staff', 'founder')),
  created_at timestamptz not null default now(),
  unique (workspace_id, phone)
);

create index if not exists operator_allowlist_phone_idx
  on public.operator_allowlist (phone);

create index if not exists operator_allowlist_workspace_idx
  on public.operator_allowlist (workspace_id);

alter table public.operator_allowlist enable row level security;

-- ── founder auto-insert trigger ──────────────────────────────────────────────
-- Every new customer (workspace) gets a founder row inserted automatically.
-- No-op when platform_settings.founder_phone is unset, so this is safe to
-- apply before the post-deploy seed runs.
create or replace function public.ensure_founder_in_allowlist()
  returns trigger
  language plpgsql
  security definer
as $$
declare
  fp text;
begin
  select value into fp from public.platform_settings where key = 'founder_phone';
  if fp is not null and length(fp) > 0 then
    insert into public.operator_allowlist (workspace_id, phone, role)
      values (new.id, fp, 'founder')
    on conflict (workspace_id, phone) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists ensure_founder_in_allowlist_on_customer on public.customers;
create trigger ensure_founder_in_allowlist_on_customer
  after insert on public.customers
  for each row execute function public.ensure_founder_in_allowlist();

-- ── backfill: owners from existing operator_whatsapp_number ──────────────────
insert into public.operator_allowlist (workspace_id, phone, role)
  select wac.workspace_id, wac.operator_whatsapp_number, 'owner'
  from public.workspace_ai_config wac
  where wac.operator_whatsapp_number is not null
    and length(wac.operator_whatsapp_number) > 0
on conflict (workspace_id, phone) do nothing;

-- ── backfill: founder on existing workspaces (conditional on seed) ───────────
-- No-op when founder_phone hasn't been seeded yet. Re-run this block after
-- seeding platform_settings.founder_phone.
insert into public.operator_allowlist (workspace_id, phone, role)
  select c.id, ps.value, 'founder'
  from public.customers c, public.platform_settings ps
  where ps.key = 'founder_phone' and length(ps.value) > 0
on conflict (workspace_id, phone) do nothing;

-- ── POST-DEPLOY (manual, one-time, founder bootstrap) ───────────────────────
--   insert into public.platform_settings (key, value)
--     values ('founder_phone', '+1242XXXXXXX')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
--
-- After seeding founder_phone, re-run the conditional founder backfill above
-- to populate founder rows on existing workspaces. New workspaces are handled
-- automatically by the trigger.
