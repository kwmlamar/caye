-- 2026-08-07 — workspace_events: one canonical stream of what happened
--
-- Phase 1 of briefs/workspace-events-plan.md.
--
-- WHY THIS EXISTS
-- On 2026-08-07 Caye was asked "who was the last person to email me?" on the
-- TropiTech Outreach workspace and answered that nothing had come in for a
-- week and the email channel might not be connected. Both false: the channel
-- had been active since 2026-07-23 and 34 inbound customer messages had
-- arrived in 14 days, the most recent 21 hours earlier.
--
-- It was not a prompt failure. getActivitySince (lib/caye-agent/activity-since.ts)
-- — the only thing behind get_recent_activity — reads bookings, holds,
-- escalations, and customer messages ONLY on already-held threads. An
-- ordinary inbound message on a non-held thread produces no event at all,
-- and no other read tool can answer "what came in" without being told whose
-- thread to look at. A perfectly prompt-compliant Caye returns the same
-- wrong answer.
--
-- This table is the fix: every question Caye answers about what is happening,
-- and every proactive message she sends, reads from here.
--
-- WHY TRIGGERS AND NOT APPLICATION CODE
-- 22 files insert into unified_messages; 6 insert into bookings. This
-- codebase's characteristic failure is the forgotten write path —
-- bookings.conversation_id populated on 10 of 616 rows, nudge-scan built and
-- unit-tested but never registered on cron, an operator phone stored without
-- its country code. Adding a remembering obligation to 28 call sites in that
-- context produces a stream that is mostly complete, and a mostly-complete
-- event stream is MORE dangerous than none: it lets Caye report "nothing
-- happened" with total confidence. That is the exact bug being fixed here.
--
-- If a row exists, the event exists. That property is the whole point.
--
-- FACTS HERE, POLICY IN CODE
-- The table stores what happened (actor_kind, is_failure), never whether it
-- is worth telling anyone. Reportability — currently "the outside world did
-- it, OR something that should have happened didn't" — is derived at read
-- time in TypeScript so it can be tuned in one file instead of a migration.
-- Do not add a `significance` column here.
--
-- Reversible: drop the triggers, then the functions, then the two tables.
-- Source tables are untouched, so a rebuild is just re-running the backfill.

-- ---------------------------------------------------------------------------
-- 1. The stream
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_events (
  id                bigint generated always as identity primary key,
  workspace_id      uuid        not null,
  occurred_at       timestamptz not null,
  type              text        not null,
  -- Who caused it. 'outside' = a person outside the business (guest, lead,
  -- mail server). Drives the default reporting lens; see FACTS/POLICY above.
  actor_kind        text        not null
                    check (actor_kind in ('outside', 'caye', 'operator', 'system')),
  -- True when this event is something that was supposed to happen and didn't.
  -- Reportable regardless of actor_kind — a cron that failed to run is the
  -- highest-priority event in the system, because it means this stream is
  -- lying about everything else.
  is_failure        boolean     not null default false,
  subject_table     text,
  subject_id        text,
  conversation_id   uuid,
  payload           jsonb       not null default '{}'::jsonb,
  -- 'trigger' rows are rebuildable from source tables. 'app' rows are trusted
  -- on faith and every one of them is a standing question of "why does this
  -- not have a row of its own?"
  origin            text        not null default 'trigger'
                    check (origin in ('trigger', 'app')),
  created_at        timestamptz not null default now()
);

-- Cursor scans ("everything after id N for this workspace") are the hot path.
create index if not exists workspace_events_workspace_id_idx
  on public.workspace_events (workspace_id, id);

create index if not exists workspace_events_workspace_occurred_idx
  on public.workspace_events (workspace_id, occurred_at desc);

create index if not exists workspace_events_conversation_idx
  on public.workspace_events (conversation_id)
  where conversation_id is not null;

comment on table public.workspace_events is
  'Canonical stream of everything that happened in a workspace. Trigger-derived; see briefs/workspace-events-plan.md. Stores facts only — reportability is decided at read time in TypeScript.';

-- ---------------------------------------------------------------------------
-- 2. Per-person delivery cursors
-- ---------------------------------------------------------------------------
--
-- High-water mark per operator. operator_allowlist rows are already
-- workspace-scoped, so one row per allowlist entry is the natural grain; a
-- person on four workspaces (currently only Lamar) has four cursors and one
-- batched digest assembled across them.
--
-- The cursor advances ONLY when Caye actually sends something. Reading a
-- thread in Caye Direct does not advance it — that surface is read-only
-- ("REPLIES VIA WHATSAPP"), and letting a glance silently consume digest
-- items means losing things you never registered. Fail toward telling twice.

create table if not exists public.workspace_event_cursors (
  operator_allowlist_id   bigint      primary key
                          references public.operator_allowlist (id) on delete cascade,
  workspace_id            uuid        not null,
  last_delivered_event_id bigint      not null default 0,
  last_delivered_at       timestamptz,
  updated_at              timestamptz not null default now()
);

comment on table public.workspace_event_cursors is
  'Per-operator high-water mark into workspace_events. Advances only on an actual send, never on a dashboard read.';

-- ---------------------------------------------------------------------------
-- 3. Trigger plumbing
-- ---------------------------------------------------------------------------
--
-- NOTE FOR ANYONE READING THE TYPESCRIPT: these fire invisibly. Nothing in
-- app/api/** or lib/** mentions workspace_events, and it must stay that way —
-- see WHY TRIGGERS above. Write-site comments point back at this migration.

create or replace function public.caye_workspace_for_conversation(conv_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select ca.user_id
    from unified_conversations uc
    join connected_accounts ca on ca.id = uc.connected_account_id
   where uc.id = conv_id
$$;

-- Messages -------------------------------------------------------------------
create or replace function public.caye_event_on_unified_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid;
begin
  ws := public.caye_workspace_for_conversation(new.conversation_id);
  if ws is null then
    -- Orphaned conversation. Losing the event is strictly better than
    -- blocking the message insert.
    return new;
  end if;

  insert into public.workspace_events
    (workspace_id, occurred_at, type, actor_kind, is_failure,
     subject_table, subject_id, conversation_id, payload)
  values (
    ws,
    new.sent_at,
    case
      when new.is_internal then 'message.internal_note'
      when new.sender_type = 'customer' then 'message.inbound'
      else 'message.outbound'
    end,
    case
      when new.sender_type = 'customer' then 'outside'
      when new.is_internal then 'caye'
      when coalesce(new.metadata->>'generated_by', '') = 'caye' then 'caye'
      else 'operator'
    end,
    new.failed_at is not null,
    'unified_messages',
    new.id::text,
    new.conversation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'sender_type', new.sender_type::text,
      'is_internal', new.is_internal,
      'preview', left(coalesce(new.content, ''), 200),
      'generated_by', new.metadata->>'generated_by',
      'is_correction', new.metadata->>'is_correction'
    ))
  );
  return new;
end;
$$;

drop trigger if exists trg_caye_event_unified_message on public.unified_messages;
create trigger trg_caye_event_unified_message
  after insert on public.unified_messages
  for each row execute function public.caye_event_on_unified_message();

-- Bookings -------------------------------------------------------------------
create or replace function public.caye_event_on_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.workspace_events
      (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id,
       conversation_id, payload)
    values (
      new.user_id, new.created_at, 'booking.created',
      -- A booking Caye made is hers; anything else was put there by a human.
      case when new.source = 'caye' then 'caye' else 'operator' end,
      'bookings', new.id::text, new.conversation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'customer', new.customer_name,
        'booking_date', new.booking_date,
        'status', new.status::text,
        'source', new.source,
        'guests', new.number_of_people
      ))
    );
  elsif new.status is distinct from old.status then
    insert into public.workspace_events
      (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id,
       conversation_id, payload)
    values (
      new.user_id, now(), 'booking.status_changed', 'operator',
      'bookings', new.id::text, new.conversation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'customer', new.customer_name,
        'booking_date', new.booking_date,
        'from', old.status::text,
        'to', new.status::text
      ))
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_caye_event_booking on public.bookings;
create trigger trg_caye_event_booking
  after insert or update on public.bookings
  for each row execute function public.caye_event_on_booking();

-- Escalations ----------------------------------------------------------------
create or replace function public.caye_event_on_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.workspace_events
      (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id,
       conversation_id, payload)
    values (new.workspace_id, new.created_at, 'escalation.opened', 'caye',
            'caye_escalations', new.id::text, new.conversation_id,
            jsonb_build_object('category', new.category, 'route_to', new.route_to));
    return new;
  end if;

  if new.owner_responded_at is distinct from old.owner_responded_at
     and new.owner_responded_at is not null then
    insert into public.workspace_events
      (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id,
       conversation_id, payload)
    values (new.workspace_id, new.owner_responded_at, 'escalation.resolved',
            'operator', 'caye_escalations', new.id::text, new.conversation_id,
            jsonb_build_object('category', new.category));
  end if;

  -- An escalation that timed out is the operator never answering. Recorded as
  -- a failure so it surfaces even though no outsider caused it.
  if new.expired_at is distinct from old.expired_at and new.expired_at is not null then
    insert into public.workspace_events
      (workspace_id, occurred_at, type, actor_kind, is_failure, subject_table,
       subject_id, conversation_id, payload)
    values (new.workspace_id, new.expired_at, 'escalation.expired', 'system',
            true, 'caye_escalations', new.id::text, new.conversation_id,
            jsonb_build_object('category', new.category));
  end if;

  return new;
end;
$$;

drop trigger if exists trg_caye_event_escalation on public.caye_escalations;
create trigger trg_caye_event_escalation
  after insert or update on public.caye_escalations
  for each row execute function public.caye_event_on_escalation();

-- Holds ----------------------------------------------------------------------
create or replace function public.caye_event_on_hold_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid;
begin
  if new.human_agent_enabled is not distinct from old.human_agent_enabled then
    return new;
  end if;

  select ca.user_id into ws
    from connected_accounts ca
   where ca.id = new.connected_account_id;
  if ws is null then
    return new;
  end if;

  insert into public.workspace_events
    (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id,
     conversation_id, payload)
  values (
    ws,
    coalesce(new.human_agent_marked_at, now()),
    case when new.human_agent_enabled then 'hold.opened' else 'hold.cleared' end,
    'caye',
    'unified_conversations', new.id::text, new.id,
    jsonb_strip_nulls(jsonb_build_object(
      'customer', new.customer_name,
      'channel', new.channel_type::text,
      'reason', new.human_agent_reason
    ))
  );
  return new;
end;
$$;

drop trigger if exists trg_caye_event_hold_change on public.unified_conversations;
create trigger trg_caye_event_hold_change
  after update on public.unified_conversations
  for each row execute function public.caye_event_on_hold_change();

-- Channels -------------------------------------------------------------------
-- A channel going down is why Caye stops hearing from an entire population of
-- guests at once, and today nothing notices. Always a failure when it happens.
create or replace function public.caye_event_on_connected_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.workspace_events
      (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload)
    values (new.user_id, new.created_at, 'channel.connected', 'operator',
            'connected_accounts', new.id::text,
            jsonb_build_object('channel', new.channel_type::text));
    return new;
  end if;

  if new.is_active is distinct from old.is_active then
    insert into public.workspace_events
      (workspace_id, occurred_at, type, actor_kind, is_failure, subject_table,
       subject_id, payload)
    values (new.user_id, now(),
            case when new.is_active then 'channel.reconnected' else 'channel.disconnected' end,
            'system', not new.is_active, 'connected_accounts', new.id::text,
            jsonb_build_object('channel', new.channel_type::text));
  end if;

  if new.needs_reauth is distinct from old.needs_reauth and new.needs_reauth then
    insert into public.workspace_events
      (workspace_id, occurred_at, type, actor_kind, is_failure, subject_table,
       subject_id, payload)
    values (new.user_id, now(), 'channel.needs_reauth', 'system', true,
            'connected_accounts', new.id::text,
            jsonb_build_object('channel', new.channel_type::text));
  end if;

  return new;
end;
$$;

drop trigger if exists trg_caye_event_connected_account on public.connected_accounts;
create trigger trg_caye_event_connected_account
  after insert or update on public.connected_accounts
  for each row execute function public.caye_event_on_connected_account();

-- ---------------------------------------------------------------------------
-- 4. Backfill — and the cursor seed, in the same transaction
-- ---------------------------------------------------------------------------
--
-- THE STANDING RULE: BACKFILLED EVENTS ARE BORN ALREADY-DELIVERED.
--
-- Without the seed below, every cursor starts at 0, the first digest contains
-- the entire history of the business, and Caye's debut as a proactive
-- assistant is a several-thousand-line message to every operator. Same shape
-- as the auto-complete pass in briefs/cold-followup-plan.md that would have
-- emailed 604 historical bookings on its first run.
--
-- Any future backfill — new event type, new source table, a repair — must
-- seed cursors in the same transaction. This is not optional and it is not
-- specific to this migration.
--
-- Guarded on the table being empty so a re-run cannot double-insert.

do $$
declare
  high_water bigint;
begin
  if exists (select 1 from public.workspace_events) then
    raise notice 'workspace_events already populated — skipping backfill';
    return;
  end if;

  insert into public.workspace_events
    (workspace_id, occurred_at, type, actor_kind, is_failure, subject_table,
     subject_id, conversation_id, payload)
  select
    ca.user_id,
    um.sent_at,
    case
      when um.is_internal then 'message.internal_note'
      when um.sender_type = 'customer' then 'message.inbound'
      else 'message.outbound'
    end,
    case
      when um.sender_type = 'customer' then 'outside'
      when um.is_internal then 'caye'
      when coalesce(um.metadata->>'generated_by', '') = 'caye' then 'caye'
      else 'operator'
    end,
    um.failed_at is not null,
    'unified_messages',
    um.id::text,
    um.conversation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'sender_type', um.sender_type::text,
      'is_internal', um.is_internal,
      'preview', left(coalesce(um.content, ''), 200),
      'generated_by', um.metadata->>'generated_by',
      'backfilled', true
    ))
  from unified_messages um
  join unified_conversations uc on uc.id = um.conversation_id
  join connected_accounts ca on ca.id = uc.connected_account_id
  order by um.sent_at;

  insert into public.workspace_events
    (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id,
     conversation_id, payload)
  select b.user_id, b.created_at, 'booking.created',
         case when b.source = 'caye' then 'caye' else 'operator' end,
         'bookings', b.id::text, b.conversation_id,
         jsonb_strip_nulls(jsonb_build_object(
           'customer', b.customer_name,
           'booking_date', b.booking_date,
           'status', b.status::text,
           'source', b.source,
           'backfilled', true
         ))
  from bookings b
  order by b.created_at;

  insert into public.workspace_events
    (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id,
     conversation_id, payload)
  select e.workspace_id, e.created_at, 'escalation.opened', 'caye',
         'caye_escalations', e.id::text, e.conversation_id,
         jsonb_build_object('category', e.category, 'route_to', e.route_to,
                            'backfilled', true)
  from caye_escalations e
  order by e.created_at;

  -- Holds: only the most recent transition per conversation survives in the
  -- source table, so history here is the current state, not a full timeline.
  insert into public.workspace_events
    (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id,
     conversation_id, payload)
  select ca.user_id, uc.human_agent_marked_at,
         case when uc.human_agent_enabled then 'hold.opened' else 'hold.cleared' end,
         'caye', 'unified_conversations', uc.id::text, uc.id,
         jsonb_strip_nulls(jsonb_build_object(
           'customer', uc.customer_name,
           'channel', uc.channel_type::text,
           'backfilled', true
         ))
  from unified_conversations uc
  join connected_accounts ca on ca.id = uc.connected_account_id
  where uc.human_agent_marked_at is not null
  order by uc.human_agent_marked_at;

  insert into public.workspace_events
    (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload)
  select ca.user_id, ca.created_at, 'channel.connected', 'operator',
         'connected_accounts', ca.id::text,
         jsonb_build_object('channel', ca.channel_type::text, 'backfilled', true)
  from connected_accounts ca
  order by ca.created_at;

  select coalesce(max(id), 0) into high_water from public.workspace_events;

  insert into public.workspace_event_cursors
    (operator_allowlist_id, workspace_id, last_delivered_event_id)
  select oa.id, oa.workspace_id, high_water
  from public.operator_allowlist oa
  on conflict (operator_allowlist_id) do nothing;

  raise notice 'workspace_events backfill complete: % events, cursors seeded to %',
    high_water, high_water;
end
$$;

-- A new operator added later must not receive the entire backlog either.
create or replace function public.caye_seed_cursor_for_new_operator()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.workspace_event_cursors
    (operator_allowlist_id, workspace_id, last_delivered_event_id)
  values (new.id, new.workspace_id,
          coalesce((select max(id) from public.workspace_events
                     where workspace_id = new.workspace_id), 0))
  on conflict (operator_allowlist_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_caye_seed_cursor on public.operator_allowlist;
create trigger trg_caye_seed_cursor
  after insert on public.operator_allowlist
  for each row execute function public.caye_seed_cursor_for_new_operator();

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
-- Deny-by-default, matching 20260807b. Every reader goes through
-- createServiceClient, which bypasses RLS. No policies is the intended state,
-- not an unfinished job — a future client-side reader should fail loudly and
-- get an explicit, reviewed policy.

alter table public.workspace_events        enable row level security;
alter table public.workspace_event_cursors enable row level security;
