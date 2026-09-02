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

-- ── Canonical identity backfill ────────────────────────────────────────────
--
-- 2026-09-02: the original version of this section keyed EVERY logistics fact
-- mentioning a meeting/pickup point as either
--   service.<service_id>.meeting_point   (when service_id was set)
--   workspace.meeting_point              (otherwise)
-- and then superseded all but the top-ranked row per key.
--
-- No legacy fact has service_id set, so in practice every such fact collapsed
-- into one workspace-wide key. On the live Bimini workspace that put
--   "The meeting point for the Heritage Tour is the pink building by the dock."
-- and
--   "The pickup location for all tours is the Casino Tram Stop."
-- into the same bucket and silently retired the first. Those two are not
-- contradictory: one is scoped to a single service, the other is explicitly
-- workspace-wide. The scope simply was not encoded anywhere the SQL could see.
--
-- The corrected derivation below encodes scope, and — the important part —
-- returns NULL whenever scope cannot be established. An unresolved fact stays
-- exactly as it is: visible, active, never superseded. Losing a real piece of
-- business knowledge is far worse than leaving a canonical key unset, and a
-- key can always be assigned later once the fact is linked to a service.

-- Property vocabulary, mirroring propertyAlias() in lib/business-learning/model.ts.
-- Unknown property -> NULL: this backfill never invents an identity.
create or replace function public.business_fact_canonical_property(p_fact text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $fn$
  select case
    when p_fact ~* '(meeting[ -]?point|pick[ -]?up[ -]?(location|point)?|pickup[ -]?(location|point)?|where (to|we) meet)'
      then 'meeting_point'
    when p_fact ~* 'payment[ -]?method' then 'payment_method'
    when p_fact ~* 'cancel(lation)?[ -]?policy' then 'cancellation_policy'
    when p_fact ~* 'refund[ -]?policy' then 'refund_policy'
    else null
  end;
$fn$;

-- True when the fact explicitly generalises across the whole business.
-- "all tours", "every service", "any booking" — an owner saying this is
-- deliberately overriding per-service variation, so workspace scope is correct.
create or replace function public.business_fact_is_workspace_scoped(p_fact text)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $fn$
  select p_fact ~* '\y(all|every|any|each)\y[ -]+(our[ -]+)?(tour|trip|excursion|charter|rental|service|package|booking|guest|customer)s?\y';
$fn$;

-- True when the fact singles something out — a named offering, a named place,
-- a specific party. Deliberately broad, because its ONLY effect is to withhold
-- a canonical key. A fact that names something specific which we cannot resolve
-- to a service must never be filed under a workspace-wide property.
create or replace function public.business_fact_has_specific_qualifier(p_fact text)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $fn$
  select
    -- "... the Heritage Tour ...", "... Sunset Charter ..." : a capitalised
    -- proper noun immediately before an offering noun.
    p_fact ~ '\y[A-Z][A-Za-z''-]+([ -]+[A-Z][A-Za-z''-]+)*[ -]+(Tour|Trip|Excursion|Charter|Rental|Package|Cruise|Experience)s?\y'
    -- "In Exuma, ...", "Nassau office ..." : a place-qualified statement.
    or p_fact ~ '\y(In|At|For|From)[ -]+[A-Z][A-Za-z''-]+'
    or p_fact ~ '\y[A-Z][A-Za-z''-]+[ -]+(office|location|branch|dock|terminal|port)\y';
$fn$;

/**
 * Canonical key for a legacy business fact, or NULL when scope is not provable.
 *
 * Scope precedence, strongest evidence first:
 *   1. service_id set                      -> service.<service_id>.<property>
 *   2. fact names a real service of this workspace, by name or alias
 *                                          -> service.<matched service_id>.<property>
 *   3. fact names something specific we could not resolve
 *                                          -> NULL   (never collapse to workspace)
 *   4. fact explicitly generalises         -> workspace.<property>
 *   5. anything else                       -> NULL   (silent scope; do not guess)
 *
 * Rule 3 outranks rule 4 on purpose: "the meeting point for the Heritage Tour"
 * contains no universal quantifier, but even if it did, naming a specific
 * offering is the stronger signal and must win.
 */
create or replace function public.derive_business_fact_canonical_key(
  p_workspace_id uuid,
  p_service_id uuid,
  p_category text,
  p_fact text
)
returns text
language plpgsql
stable
set search_path = pg_catalog, public
as $fn$
declare
  v_property text;
  v_service_id uuid;
begin
  if p_category is distinct from 'logistics' then
    -- Widen deliberately, one category at a time, with dry-run evidence each
    -- time. Logistics is the only category audited so far.
    return null;
  end if;

  v_property := public.business_fact_canonical_property(p_fact);
  if v_property is null then return null; end if;

  -- 1. structural scope always wins
  if p_service_id is not null then
    return 'service.' || p_service_id::text || '.' || v_property;
  end if;

  -- 2. resolve a named offering against this workspace's real services.
  --    Longest name first so "Heritage Tour Deluxe" beats "Heritage Tour".
  select s.id into v_service_id
  from public.booking_services s
  where s.workspace_id = p_workspace_id
    and length(btrim(coalesce(s.name, ''))) > 2
    and p_fact ~* ('\y' || regexp_replace(btrim(s.name), '([.^$*+?()\[\]{}|\\])', '\\\1', 'g') || '\y')
  order by length(s.name) desc
  limit 1;

  if v_service_id is not null then
    return 'service.' || v_service_id::text || '.' || v_property;
  end if;

  -- 3. names something specific that did not resolve -> leave unresolved
  if public.business_fact_has_specific_qualifier(p_fact) then
    return null;
  end if;

  -- 4. explicitly business-wide
  if public.business_fact_is_workspace_scoped(p_fact) then
    return 'workspace.' || v_property;
  end if;

  -- 5. no provable scope
  return null;
end;
$fn$;

revoke all on function public.business_fact_canonical_property(text) from public, anon, authenticated;
revoke all on function public.business_fact_is_workspace_scoped(text) from public, anon, authenticated;
revoke all on function public.business_fact_has_specific_qualifier(text) from public, anon, authenticated;
revoke all on function public.derive_business_fact_canonical_key(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.business_fact_canonical_property(text) to service_role;
grant execute on function public.business_fact_is_workspace_scoped(text) to service_role;
grant execute on function public.business_fact_has_specific_qualifier(text) to service_role;
grant execute on function public.derive_business_fact_canonical_key(uuid, uuid, text, text) to service_role;

update public.business_facts f
set canonical_key = public.derive_business_fact_canonical_key(
  f.workspace_id, f.service_id, f.category, f.fact
)
where f.canonical_key is null
  and public.derive_business_fact_canonical_key(
        f.workspace_id, f.service_id, f.category, f.fact
      ) is not null;

-- Legacy owner-direct rows predate canonical identity. Within ONE canonical
-- key — which now carries scope — retain the highest-authority/newest row and
-- preserve the others as auditable superseded history. Lower-authority evidence
-- can never win merely because it is newer.
--
-- Rows with a NULL canonical_key are untouched by construction: they never
-- enter a partition, so an unresolved fact cannot be retired by this migration.
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
