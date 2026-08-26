-- Deterministic evidence for cold-outreach delivery safety recovery.
-- Deploy before application code: the code writes these receipts and calls the
-- two service-role RPCs below. Legacy bounce rows intentionally remain
-- unresolved so a historical pause cannot be guessed into a recovery.

alter table public.workspace_ai_config
  add column if not exists outreach_pause_generation uuid;

alter table public.caye_outreach_pause_events
  add column if not exists pause_generation uuid;

create table if not exists public.caye_outreach_outbound_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  lead_id uuid not null references public.outreach_leads(id) on delete cascade,
  unified_message_id uuid not null references public.unified_messages(id) on delete cascade,
  recipient_email text not null,
  touch_kind text not null check (touch_kind in ('first_touch', 'followup')),
  provider text not null,
  provider_message_id text,
  sent_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (unified_message_id)
);
create index if not exists caye_outreach_outbound_receipts_recipient_idx
  on public.caye_outreach_outbound_receipts (workspace_id, recipient_email, sent_at desc);
create unique index if not exists caye_outreach_outbound_receipts_provider_message_idx
  on public.caye_outreach_outbound_receipts (workspace_id, provider, provider_message_id)
  where provider_message_id is not null;
alter table public.caye_outreach_outbound_receipts enable row level security;

alter table public.caye_outreach_bounces
  add column if not exists inbound_message_id uuid references public.unified_messages(id) on delete set null,
  add column if not exists inbound_provider_message_id text,
  add column if not exists outbound_receipt_id uuid references public.caye_outreach_outbound_receipts(id) on delete set null,
  add column if not exists lead_id uuid references public.outreach_leads(id) on delete set null,
  add column if not exists recipient_email text,
  add column if not exists provider text,
  add column if not exists bounce_classification text,
  add column if not exists attribution_status text,
  add column if not exists attribution_reason text,
  add column if not exists recipient_suppressed_at timestamptz;

update public.caye_outreach_bounces
  set attribution_status = 'legacy_unknown',
      attribution_reason = coalesce(attribution_reason, 'No deterministic inbound/provider evidence was stored for this historical bounce.')
  where attribution_status is null;

alter table public.caye_outreach_bounces
  alter column attribution_status set not null;
alter table public.caye_outreach_bounces
  drop constraint if exists caye_outreach_bounces_attribution_status_check;
alter table public.caye_outreach_bounces
  add constraint caye_outreach_bounces_attribution_status_check
  check (attribution_status in ('outbound_attributed', 'recipient_attributed', 'ambiguous', 'unmatched', 'legacy_unknown'));
create unique index if not exists caye_outreach_bounces_inbound_message_idx
  on public.caye_outreach_bounces (workspace_id, inbound_message_id)
  where inbound_message_id is not null;

create table if not exists public.caye_outreach_safety_recovery_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  pause_generation uuid,
  allowed boolean not null,
  blockers jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  evaluated_at timestamptz not null default now(),
  actor_role text not null check (actor_role in ('owner', 'founder', 'system'))
);
create index if not exists caye_outreach_safety_recovery_evidence_workspace_idx
  on public.caye_outreach_safety_recovery_evidence (workspace_id, evaluated_at desc);
alter table public.caye_outreach_safety_recovery_evidence enable row level security;

-- Atomically append one new bounce and, if necessary, establish a fresh pause
-- generation. Both bounce recording and recovery lock this config row, so an
-- arriving safety event always serializes against a recovery attempt.
create or replace function public.record_outreach_bounce(
  p_workspace_id uuid,
  p_inbound_message_id uuid,
  p_inbound_provider_message_id text,
  p_outbound_receipt_id uuid,
  p_lead_id uuid,
  p_recipient_email text,
  p_provider text,
  p_bounce_classification text,
  p_attribution_status text,
  p_attribution_reason text,
  p_recipient_suppressed_at timestamptz,
  p_occurred_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare cfg public.workspace_ai_config%rowtype;
declare v_count integer; v_generation uuid; v_inserted uuid;
begin
  select * into cfg from public.workspace_ai_config where workspace_id = p_workspace_id for update;
  if not found then raise exception 'outreach config missing for workspace %', p_workspace_id; end if;

  insert into public.caye_outreach_bounces (
    workspace_id, inbound_message_id, inbound_provider_message_id,
    outbound_receipt_id, lead_id, recipient_email, provider,
    bounce_classification, attribution_status, attribution_reason,
    recipient_suppressed_at, created_at
  ) values (
    p_workspace_id, p_inbound_message_id, p_inbound_provider_message_id,
    p_outbound_receipt_id, p_lead_id, p_recipient_email, p_provider,
    p_bounce_classification, p_attribution_status, p_attribution_reason,
    p_recipient_suppressed_at, coalesce(p_occurred_at, now())
  ) on conflict (workspace_id, inbound_message_id) where inbound_message_id is not null do nothing
  returning id into v_inserted;

  if v_inserted is null then return jsonb_build_object('recorded', false, 'tripped', false); end if;
  if cfg.outreach_autosend_paused then return jsonb_build_object('recorded', true, 'tripped', false); end if;

  select count(*) into v_count from public.caye_outreach_bounces
    where workspace_id = p_workspace_id
      and created_at >= now() - make_interval(hours => coalesce(cfg.outreach_bounce_window_hours, 24));
  if v_count < coalesce(cfg.outreach_bounce_threshold, 5) then
    return jsonb_build_object('recorded', true, 'tripped', false, 'count', v_count);
  end if;

  v_generation := gen_random_uuid();
  update public.workspace_ai_config set
    outreach_autosend_paused = true,
    outreach_pause_source = 'bounce_safety',
    outreach_pause_reason = format('%s bounces in the trailing %s hours crossed the safety threshold of %s.', v_count, coalesce(cfg.outreach_bounce_window_hours, 24), coalesce(cfg.outreach_bounce_threshold, 5)),
    outreach_paused_at = now(),
    outreach_pause_generation = v_generation
    where workspace_id = p_workspace_id;
  insert into public.caye_outreach_pause_events (workspace_id, action, source, reason, actor_role, pause_generation)
    values (p_workspace_id, 'paused', 'bounce_safety', format('%s bounces in the trailing %s hours crossed the safety threshold of %s.', v_count, coalesce(cfg.outreach_bounce_window_hours, 24), coalesce(cfg.outreach_bounce_threshold, 5)), 'system', v_generation);
  return jsonb_build_object('recorded', true, 'tripped', true, 'count', v_count, 'window_hours', coalesce(cfg.outreach_bounce_window_hours, 24));
end;
$$;

-- The final recovery gate. It rechecks the rolling threshold and every bounce
-- in the triggering window while holding the same config row as bounce
-- recording. A false result leaves the pause untouched.
create or replace function public.recover_outreach_bounce_safety(
  p_workspace_id uuid,
  p_expected_generation uuid
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare cfg public.workspace_ai_config%rowtype; v_active integer; v_unresolved integer;
begin
  select * into cfg from public.workspace_ai_config where workspace_id = p_workspace_id for update;
  if not found or not cfg.outreach_autosend_paused or cfg.outreach_pause_source <> 'bounce_safety'
    or cfg.outreach_pause_generation is distinct from p_expected_generation then return false; end if;
  if not exists (
    select 1 from public.connected_accounts
      where user_id = p_workspace_id and channel_type = 'email' and is_active = true
        and (refresh_token is not null or token_expires_at > now())
  ) then return false; end if;
  select count(*) into v_active from public.caye_outreach_bounces
    where workspace_id = p_workspace_id
      and created_at >= now() - make_interval(hours => coalesce(cfg.outreach_bounce_window_hours, 24));
  if v_active >= coalesce(cfg.outreach_bounce_threshold, 5) then return false; end if;
  select count(*) into v_unresolved from public.caye_outreach_bounces
    where workspace_id = p_workspace_id
      and created_at >= cfg.outreach_paused_at - make_interval(hours => coalesce(cfg.outreach_bounce_window_hours, 24))
      and (inbound_message_id is null or recipient_email is null or recipient_suppressed_at is null
        or attribution_status not in ('outbound_attributed', 'recipient_attributed'));
  if v_unresolved > 0 then return false; end if;
  update public.workspace_ai_config set outreach_autosend_paused = false,
    outreach_pause_source = null, outreach_pause_reason = null, outreach_paused_at = null,
    outreach_pause_generation = null where workspace_id = p_workspace_id;
  insert into public.caye_outreach_pause_events (workspace_id, action, source, reason, actor_role, pause_generation)
    values (p_workspace_id, 'resumed', 'bounce_safety', 'Deterministic bounce recovery evidence satisfied.', 'system', p_expected_generation);
  return true;
end;
$$;

-- Owner authority may release an owner-originated pause only while no live
-- bounce/provider condition exists. It shares the config-row lock with
-- record_outreach_bounce, so a concurrent safety event wins.
create or replace function public.resume_owner_outreach(
  p_workspace_id uuid,
  p_expected_generation uuid,
  p_actor_role text
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare cfg public.workspace_ai_config%rowtype; v_active integer;
begin
  if p_actor_role not in ('owner', 'founder') then return false; end if;
  select * into cfg from public.workspace_ai_config where workspace_id = p_workspace_id for update;
  if not found or not cfg.outreach_autosend_paused or cfg.outreach_pause_source <> 'owner_manual'
    or cfg.outreach_pause_generation is distinct from p_expected_generation then return false; end if;
  select count(*) into v_active from public.caye_outreach_bounces
    where workspace_id = p_workspace_id
      and created_at >= now() - make_interval(hours => coalesce(cfg.outreach_bounce_window_hours, 24));
  if v_active >= coalesce(cfg.outreach_bounce_threshold, 5) then return false; end if;
  if not exists (
    select 1 from public.connected_accounts
      where user_id = p_workspace_id and channel_type = 'email' and is_active = true
        and (refresh_token is not null or token_expires_at > now())
  ) then return false; end if;
  update public.workspace_ai_config set outreach_autosend_paused = false,
    outreach_pause_source = null, outreach_pause_reason = null, outreach_paused_at = null,
    outreach_pause_generation = null where workspace_id = p_workspace_id;
  insert into public.caye_outreach_pause_events (workspace_id, action, source, reason, actor_role, pause_generation)
    values (p_workspace_id, 'resumed', 'owner_manual', 'Owner-authorized recovery with no active safety blocker.', p_actor_role, p_expected_generation);
  return true;
end;
$$;

revoke all on function public.record_outreach_bounce(uuid, uuid, text, uuid, uuid, text, text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.record_outreach_bounce(uuid, uuid, text, uuid, uuid, text, text, text, text, text, timestamptz, timestamptz) to service_role;
revoke all on function public.recover_outreach_bounce_safety(uuid, uuid) from public, anon, authenticated;
grant execute on function public.recover_outreach_bounce_safety(uuid, uuid) to service_role;
revoke all on function public.resume_owner_outreach(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.resume_owner_outreach(uuid, uuid, text) to service_role;
