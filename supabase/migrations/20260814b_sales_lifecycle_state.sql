-- Phase 0 sales lifecycle seam. These fields normalize observed inbound facts
-- and make replay protection explicit without replacing the legacy status yet.
-- DEPLOYMENT ORDER: apply this migration before deploying application code
-- that calls sales_apply_lifecycle_event.
alter table public.outreach_leads
  add column if not exists last_inbound_kind text,
  add column if not exists outreach_deferred_at timestamptz,
  add column if not exists last_lifecycle_event_key text;

alter table public.outreach_leads
  drop constraint if exists outreach_leads_last_inbound_kind_check;
alter table public.outreach_leads
  add constraint outreach_leads_last_inbound_kind_check
  check (last_inbound_kind is null or last_inbound_kind in ('human_reply', 'automated_ooo', 'opt_out', 'bounce_or_delivery_failure', 'unknown'));

-- Receipt rows are deliberately Sales-specific. A single value on the lead
-- could only reject consecutive retries; this unique key rejects a delayed
-- provider replay even after another valid lifecycle fact was recorded.
create table if not exists public.sales_lifecycle_event_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  lead_id uuid not null references public.outreach_leads(id) on delete cascade,
  event_key text not null,
  event text not null,
  created_at timestamptz not null default now(),
  unique (lead_id, event_key)
);

create index if not exists sales_lifecycle_event_receipts_workspace_idx
  on public.sales_lifecycle_event_receipts (workspace_id, created_at desc);

-- This table contains prospect-linked lifecycle evidence. Like
-- outreach_leads and sales_lead_signals, it is service-role-only.
alter table public.sales_lifecycle_event_receipts enable row level security;

-- Apply one observed Sales fact exactly once. The row lock makes a provider
-- retry harmless and keeps the lead row and reporting signal transactional.
create or replace function public.sales_apply_lifecycle_event(
  p_workspace_id uuid,
  p_lead_id uuid,
  p_event text,
  p_event_key text,
  p_at timestamptz,
  p_reason text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  lead public.outreach_leads%rowtype;
  signal_kind text := 'outcome';
  inserted_receipt uuid;
begin
  insert into public.sales_lifecycle_event_receipts (workspace_id, lead_id, event_key, event)
    values (p_workspace_id, p_lead_id, p_event_key, p_event)
    on conflict (lead_id, event_key) do nothing
    returning id into inserted_receipt;
  if inserted_receipt is null then return false; end if;

  select * into lead from public.outreach_leads
    where id = p_lead_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'sales lead % is not in workspace %', p_lead_id, p_workspace_id;
  end if;

  if lead.stage in ('won', 'lost', 'disqualified') and p_event not in ('opted_out', 'bounce_or_delivery_failure') then
    update public.outreach_leads set last_lifecycle_event_key = p_event_key where id = lead.id;
  elsif p_event = 'first_touch_sent' and lead.first_touch_sent_at is null then
    update public.outreach_leads set stage = case when lead.stage = 'sourced' then 'contacted' else lead.stage end,
      status = 'sent', first_touch_sent_at = p_at, touches_sent = greatest(1, lead.touches_sent),
      last_touch_sent_at = p_at, last_nudge_at = p_at, last_lifecycle_event_key = p_event_key where id = lead.id;
  elsif p_event = 'followup_sent' then
    update public.outreach_leads set stage = case when lead.stage = 'sourced' then 'contacted' else lead.stage end,
      touches_sent = lead.touches_sent + 1, last_touch_sent_at = p_at, last_nudge_at = p_at,
      nudge_count = greatest(0, lead.touches_sent), last_lifecycle_event_key = p_event_key where id = lead.id;
  elsif p_event = 'human_reply_received' then
    update public.outreach_leads set stage = case when lead.stage in ('sourced', 'contacted') then 'engaged' else lead.stage end,
      status = 'replied', last_inbound_kind = 'human_reply', outreach_deferred_at = null,
      last_lifecycle_event_key = p_event_key where id = lead.id;
  elsif p_event = 'automated_reply_received' then
    update public.outreach_leads set last_inbound_kind = 'automated_ooo', outreach_deferred_at = p_at,
      last_lifecycle_event_key = p_event_key where id = lead.id;
  elsif p_event = 'inbound_unknown' then
    update public.outreach_leads set last_inbound_kind = 'unknown', outreach_deferred_at = p_at,
      last_lifecycle_event_key = p_event_key where id = lead.id;
  elsif p_event = 'demo_link_clicked' then
    update public.outreach_leads set stage = case when lead.stage in ('sourced', 'contacted', 'engaged', 'qualified') then 'demo_started' else lead.stage end,
      status = 'tried', tried_at = p_at, last_lifecycle_event_key = p_event_key where id = lead.id;
  elsif p_event = 'opted_out' then
    update public.outreach_leads set stage = 'disqualified', status = 'do_not_contact', opted_out_at = p_at,
      last_inbound_kind = 'opt_out', outreach_deferred_at = p_at, last_lifecycle_event_key = p_event_key where id = lead.id;
  elsif p_event = 'bounce_or_delivery_failure' then
    update public.outreach_leads set stage = 'disqualified', status = 'do_not_contact',
      disqualified_reason = coalesce(p_reason, 'bounce_or_delivery_failure'), last_inbound_kind = 'bounce_or_delivery_failure',
      outreach_deferred_at = p_at, last_lifecycle_event_key = p_event_key where id = lead.id;
  elsif p_event = 'disqualified' then
    signal_kind := 'disqualifier';
    update public.outreach_leads set stage = 'disqualified', disqualified_reason = coalesce(p_reason, 'disqualified'),
      last_lifecycle_event_key = p_event_key where id = lead.id;
  elsif p_event = 'marked_cold' then
    update public.outreach_leads set stage = 'lost', status = 'cold', last_lifecycle_event_key = p_event_key where id = lead.id;
  elsif p_event = 'escalated' then
    signal_kind := 'escalation';
    update public.outreach_leads set last_lifecycle_event_key = p_event_key where id = lead.id;
  else
    raise exception 'unsupported sales lifecycle event: %', p_event;
  end if;

  insert into public.sales_lead_signals (workspace_id, lead_id, kind, label, detail)
    values (p_workspace_id, p_lead_id, signal_kind, p_event, p_reason);
  return true;
end;
$$;

revoke all on function public.sales_apply_lifecycle_event(uuid, uuid, text, text, timestamptz, text) from public;
revoke all on function public.sales_apply_lifecycle_event(uuid, uuid, text, text, timestamptz, text) from anon;
revoke all on function public.sales_apply_lifecycle_event(uuid, uuid, text, text, timestamptz, text) from authenticated;
grant execute on function public.sales_apply_lifecycle_event(uuid, uuid, text, text, timestamptz, text) to service_role;
