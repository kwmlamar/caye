-- Continuous business learning: durable observation queue, trace events,
-- candidate provenance/idempotency, and canonical current-memory repair.
--
-- The observation queue is populated AFTER message persistence so learning can
-- never depend on a best-effort application callback surviving a serverless
-- response. Backfill writes the same queue rows and therefore uses the exact
-- same downstream pipeline.

create table if not exists public.business_learning_observations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  source_kind text not null,
  source_id text not null,
  source_fingerprint text not null,
  source_channel text,
  conversation_id uuid,
  unified_message_id uuid references public.unified_messages(id) on delete set null,
  operator_message_id uuid,
  content text not null,
  source_metadata jsonb not null default '{}'::jsonb,
  semantic_scope text,
  status text not null default 'pending' check (status in ('pending','processing','excluded','processed','failed')),
  exclusion_reason text,
  processing_error text,
  attempt_count integer not null default 0,
  first_seen_at timestamptz not null default now(),
  processing_started_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_fingerprint)
);

create index if not exists business_learning_observations_pending_idx
  on public.business_learning_observations(status, created_at)
  where status in ('pending','failed');
create index if not exists business_learning_observations_workspace_idx
  on public.business_learning_observations(workspace_id, created_at desc);

create table if not exists public.business_learning_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.customers(id) on delete cascade,
  event_type text not null check (event_type in (
    'observation_examined','observation_excluded','extraction_started','extraction_failed',
    'candidate_created','candidate_deduplicated','candidate_rejected','fact_promoted',
    'fact_updated','conflict_detected','conflict_resolved','fact_superseded'
  )),
  observation_id uuid references public.business_learning_observations(id) on delete set null,
  candidate_id uuid references public.business_fact_candidates(id) on delete set null,
  fact_id uuid references public.business_facts(id) on delete set null,
  source_kind text,
  source_id text,
  job_name text,
  capability text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists business_learning_events_workspace_idx
  on public.business_learning_events(workspace_id, created_at desc);
create index if not exists business_learning_events_type_idx
  on public.business_learning_events(event_type, created_at desc);

alter table public.business_fact_candidates
  add column if not exists observation_id uuid references public.business_learning_observations(id) on delete set null,
  add column if not exists canonical_key text,
  add column if not exists candidate_fingerprint text,
  add column if not exists memory_type text,
  add column if not exists authority_kind text,
  add column if not exists confidence numeric,
  add column if not exists provenance jsonb not null default '{}'::jsonb,
  add column if not exists customer_use_state text not null default 'requires_confirmation',
  add column if not exists valid_from timestamptz,
  add column if not exists source_kind text,
  add column if not exists source_id text;

create unique index if not exists business_fact_candidates_fingerprint_uidx
  on public.business_fact_candidates(workspace_id, candidate_fingerprint)
  where candidate_fingerprint is not null;
create index if not exists business_fact_candidates_canonical_idx
  on public.business_fact_candidates(workspace_id, canonical_key, status)
  where canonical_key is not null;

alter table public.business_facts
  add column if not exists customer_use_state text not null default 'authoritative';

-- Stable property identity for the most important known legacy contradiction
-- class. The key names the PROPERTY, never the value/location itself.
update public.business_facts
set canonical_key = case
  when service_id is not null then 'service.' || service_id::text || '.meeting_point'
  else 'workspace.meeting_point'
end
where canonical_key is null
  and category = 'logistics'
  and fact ~* '(meeting[ -]?point|pick[ -]?up (location|point)|pickup (location|point))';

-- Legacy owner-direct rows predate canonical identity. If several current rows
-- now describe the same property, retain the highest-authority/newest row and
-- preserve the others as auditable superseded history. Lower-authority evidence
-- can never win merely because it is newer.
with ranked as (
  select
    id,
    workspace_id,
    canonical_key,
    first_value(id) over (
      partition by workspace_id, canonical_key
      order by
        case
          when memory_type = 'correction' and authority_kind in ('owner','founder') then 700
          when authority_kind in ('owner','founder') or source in ('owner-direct','escalation-capture','operator-learning') then 600
          when source in ('onboarding','configured','business-profile') then 500
          when source in ('email','gmail','whatsapp','customer-communication') then 400
          when knowledge_mode = 'observed' then 300
          when knowledge_mode in ('inferred','derived') then 200
          else 100
        end desc,
        coalesce(valid_from, created_at) desc,
        created_at desc,
        id desc
    ) as winner_id,
    row_number() over (
      partition by workspace_id, canonical_key
      order by
        case
          when memory_type = 'correction' and authority_kind in ('owner','founder') then 700
          when authority_kind in ('owner','founder') or source in ('owner-direct','escalation-capture','operator-learning') then 600
          when source in ('onboarding','configured','business-profile') then 500
          when source in ('email','gmail','whatsapp','customer-communication') then 400
          when knowledge_mode = 'observed' then 300
          when knowledge_mode in ('inferred','derived') then 200
          else 100
        end desc,
        coalesce(valid_from, created_at) desc,
        created_at desc,
        id desc
    ) as rn
  from public.business_facts
  where superseded_at is null and canonical_key is not null
), losers as (
  select id, winner_id from ranked where rn > 1
)
update public.business_facts f
set superseded_at = now(), superseded_by = l.winner_id
from losers l
where f.id = l.id and f.superseded_at is null;

create or replace function public.enqueue_unified_message_for_business_learning()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace_id uuid;
  v_channel text;
begin
  if coalesce(new.is_internal, false) or coalesce(new.content, '') = '' then
    return new;
  end if;

  select ca.user_id, uc.channel_type::text
    into v_workspace_id, v_channel
  from public.unified_conversations uc
  join public.connected_accounts ca on ca.id = uc.connected_account_id
  where uc.id = new.conversation_id;

  if v_workspace_id is null then
    return new;
  end if;

  insert into public.business_learning_observations (
    workspace_id, source_kind, source_id, source_fingerprint, source_channel,
    conversation_id, unified_message_id, content, source_metadata
  ) values (
    v_workspace_id,
    'unified_message',
    new.id::text,
    'unified_message:' || new.id::text,
    v_channel,
    new.conversation_id,
    new.id,
    new.content,
    coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('sender_type', new.sender_type::text)
  )
  on conflict (workspace_id, source_fingerprint) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_enqueue_unified_message_for_business_learning on public.unified_messages;
create trigger trg_enqueue_unified_message_for_business_learning
after insert on public.unified_messages
for each row execute function public.enqueue_unified_message_for_business_learning();

create or replace function public.enqueue_operator_message_for_business_learning()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.direction::text <> 'inbound' or coalesce(new.body, '') = '' then
    return new;
  end if;

  insert into public.business_learning_observations (
    workspace_id, source_kind, source_id, source_fingerprint, operator_message_id,
    content, source_metadata
  ) values (
    new.workspace_id,
    'operator_message',
    new.id::text,
    'operator_message:' || new.id::text,
    new.id,
    new.body,
    jsonb_build_object(
      'operator_role', new.operator_role,
      'operator_allowlist_id', new.operator_allowlist_id,
      'intent', new.intent
    )
  )
  on conflict (workspace_id, source_fingerprint) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_enqueue_operator_message_for_business_learning on public.caye_operator_messages;
create trigger trg_enqueue_operator_message_for_business_learning
after insert on public.caye_operator_messages
for each row execute function public.enqueue_operator_message_for_business_learning();

-- Backfill helper: enqueue historical persisted business communication without
-- inventing facts. Dry-run is SELECT-only; execution inserts normal queue rows.
create or replace function public.enqueue_business_learning_backfill(
  p_workspace_id uuid,
  p_since timestamptz,
  p_limit integer default 500,
  p_dry_run boolean default true
)
returns table(source_kind text, source_id text, source_channel text, would_enqueue boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with eligible as (
    select
      'unified_message'::text as sk,
      um.id::text as sid,
      uc.channel_type::text as channel,
      um.id as message_id,
      um.conversation_id,
      um.content,
      um.metadata,
      um.sender_type::text as sender_type
    from public.unified_messages um
    join public.unified_conversations uc on uc.id = um.conversation_id
    join public.connected_accounts ca on ca.id = uc.connected_account_id
    where ca.user_id = p_workspace_id
      and um.sent_at >= p_since
      and coalesce(um.is_internal, false) = false
      and coalesce(um.content, '') <> ''
    order by um.sent_at asc
    limit greatest(1, least(coalesce(p_limit, 500), 5000))
  ), inserted as (
    insert into public.business_learning_observations (
      workspace_id, source_kind, source_id, source_fingerprint, source_channel,
      conversation_id, unified_message_id, content, source_metadata
    )
    select
      p_workspace_id, e.sk, e.sid, 'unified_message:' || e.sid, e.channel,
      e.conversation_id, e.message_id, e.content,
      coalesce(e.metadata, '{}'::jsonb) || jsonb_build_object('sender_type', e.sender_type, 'backfill', true)
    from eligible e
    where not p_dry_run
    on conflict (workspace_id, source_fingerprint) do nothing
    returning source_kind, source_id
  )
  select e.sk, e.sid, e.channel,
    not exists (
      select 1 from public.business_learning_observations o
      where o.workspace_id = p_workspace_id
        and o.source_fingerprint = 'unified_message:' || e.sid
    ) as would_enqueue
  from eligible e;
end;
$$;
