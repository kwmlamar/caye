-- 2026-07-02 — operator identity on caye_operator_messages
--
-- caye_operator_messages was workspace-scoped only — every operator sharing
-- a workspace's back-office channel (owner, staff, founder) got merged into
-- one stream with no way to tell who sent what. This broke both the Caye
-- Direct UI (looked like one person talking to themselves) and Caye's own
-- memory: lib/caye-agent/context.ts loaded history by workspace_id alone,
-- so her sliding-window context mixed every operator's exchanges together.
--
-- Snapshot columns (not just an FK) so history stays correct even if an
-- operator is later renamed or removed from operator_allowlist.
--
-- NOTE: applied directly to the live project (fetsfbdltlxjsomiqvrw) on
-- 2026-07-02 but never committed to this directory until 2026-08-13, when
-- the drift was found while auditing Caye Direct. Recovered verbatim from
-- supabase_migrations.schema_migrations. This file documents already-live
-- state; it does not change production.

alter table public.caye_operator_messages
  add column if not exists operator_allowlist_id bigint references public.operator_allowlist(id) on delete set null,
  add column if not exists operator_name text,
  add column if not exists operator_role text;

create index if not exists caye_operator_messages_operator_idx
  on public.caye_operator_messages(workspace_id, operator_allowlist_id, created_at);

comment on column public.caye_operator_messages.operator_allowlist_id is
  'Which operator_allowlist row sent (inbound) or was replied to (outbound) this message. Null for rows predating this column that could not be backfilled.';
comment on column public.caye_operator_messages.operator_name is
  'Snapshot of operator_allowlist.name at message time — survives renames/removals.';
comment on column public.caye_operator_messages.operator_role is
  'Snapshot of operator_allowlist.role at message time (owner/staff/founder).';

-- ── Data fix: Karenda's name was never captured (her allowlist row was
-- backfilled from the legacy operator_whatsapp_number column, which
-- predates the `name` column). Known from direct context — see
-- Clients/bimini-island-tours.md in the AI-OS repo.
update public.operator_allowlist
  set name = 'Karenda Swain-Rolle'
  where workspace_id = '653257d9-c0f1-4271-be6d-3e2596fd893e'
    and role = 'owner'
    and name is null;

-- ── Best-effort backfill of existing caye_operator_messages rows ──
-- Inbound: wa_message_id IS NULL means it came through the founder-dashboard
-- route (app/api/founder/caye-direct), never a real WhatsApp message —
-- attribute to the workspace's founder row. wa_message_id IS NOT NULL means
-- a real WhatsApp send — attribute to the workspace's non-founder operator
-- row (owner/staff). Can't disambiguate multiple historical WhatsApp
-- operators on the same workspace, but every workspace with history today
-- has had at most one.
with founder_op as (
  select distinct on (workspace_id) workspace_id, id, name, role
  from public.operator_allowlist
  where role = 'founder'
  order by workspace_id, created_at asc
)
update public.caye_operator_messages m
set operator_allowlist_id = f.id, operator_name = f.name, operator_role = f.role
from founder_op f
where m.workspace_id = f.workspace_id
  and m.direction = 'inbound'
  and m.wa_message_id is null
  and m.operator_allowlist_id is null;

with whatsapp_op as (
  select distinct on (workspace_id) workspace_id, id, name, role
  from public.operator_allowlist
  where role in ('owner', 'staff')
  order by workspace_id, created_at asc
)
update public.caye_operator_messages m
set operator_allowlist_id = w.id, operator_name = w.name, operator_role = w.role
from whatsapp_op w
where m.workspace_id = w.workspace_id
  and m.direction = 'inbound'
  and m.wa_message_id is not null
  and m.operator_allowlist_id is null;

-- Outbound rows inherit the operator of the immediately preceding inbound
-- row in the same workspace (the turn that triggered the reply).
with ranked as (
  select id, workspace_id, direction,
    lag(operator_allowlist_id) over (partition by workspace_id order by created_at) as prev_op_id,
    lag(operator_name) over (partition by workspace_id order by created_at) as prev_op_name,
    lag(operator_role) over (partition by workspace_id order by created_at) as prev_op_role,
    lag(direction) over (partition by workspace_id order by created_at) as prev_direction
  from public.caye_operator_messages
)
update public.caye_operator_messages m
set operator_allowlist_id = r.prev_op_id, operator_name = r.prev_op_name, operator_role = r.prev_op_role
from ranked r
where m.id = r.id
  and m.direction = 'outbound'
  and m.operator_allowlist_id is null
  and r.prev_direction = 'inbound'
  and r.prev_op_id is not null;
