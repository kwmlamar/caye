-- One durable customer-facing execution owner per conversation.  This is a
-- process boundary, not a UI hint: webhook, cron, operator and dashboard
-- workers all meet here before they can dispatch to a customer.
create table if not exists public.conversation_execution_claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  conversation_id uuid not null references public.unified_conversations(id) on delete cascade,
  holder_kind text not null check (holder_kind in ('autonomous_frontdesk', 'operator_caye', 'human_manual', 'scheduled_system', 'correction_followup')),
  triggering_message_id uuid references public.unified_messages(id) on delete set null,
  idempotency_key text not null,
  generation bigint not null default 1,
  reason text,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  completed_at timestamptz,
  superseded_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique (workspace_id, conversation_id, idempotency_key)
);

create unique index if not exists conversation_execution_one_active_claim
  on public.conversation_execution_claims (conversation_id)
  where released_at is null and completed_at is null and superseded_at is null;
create index if not exists conversation_execution_trigger_idx
  on public.conversation_execution_claims (conversation_id, triggering_message_id);

-- Durable one-response-per-customer-turn relationship.  A provider receipt
-- is filled in after dispatch; the unique inbound key stops a second worker
-- from deciding it can answer the same turn.
create table if not exists public.conversation_response_executions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  conversation_id uuid not null references public.unified_conversations(id) on delete cascade,
  inbound_message_id uuid not null references public.unified_messages(id) on delete cascade,
  claim_id uuid not null references public.conversation_execution_claims(id) on delete restrict,
  outbound_message_id uuid references public.unified_messages(id) on delete set null,
  disposition text not null check (disposition in ('reply', 'correction', 'followup', 'owner_requested')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (inbound_message_id)
);

alter table public.caye_pending_actions
  add column if not exists execution_claim_id uuid references public.conversation_execution_claims(id) on delete set null;

alter table public.conversation_execution_claims enable row level security;
alter table public.conversation_response_executions enable row level security;

-- Claims use a row lock on the canonical conversation.  Expiry alone never
-- wins over an active pending operator action: that action is durable proof
-- that the owner is still directing Caye.  An expired claim without pending
-- work is explicitly superseded and the next generation acquires ownership.
create or replace function public.claim_conversation_execution(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_holder_kind text,
  p_idempotency_key text,
  p_triggering_message_id uuid default null,
  p_reason text default null,
  p_lease_seconds integer default 900
) returns table(claim_id uuid, generation bigint, acquired boolean, blocked_by text)
language plpgsql security definer set search_path = public as $$
declare
  active public.conversation_execution_claims;
  has_pending boolean;
begin
  perform 1 from public.unified_conversations where id = p_conversation_id for update;
  select * into active from public.conversation_execution_claims
   where conversation_id = p_conversation_id and released_at is null and completed_at is null and superseded_at is null
   order by claimed_at desc limit 1 for update;
  if found then
    if active.workspace_id <> p_workspace_id then raise exception 'conversation workspace mismatch'; end if;
    if active.idempotency_key = p_idempotency_key then
      return query select active.id, active.generation, true, null::text; return;
    end if;
    select exists(select 1 from public.caye_pending_actions pa where pa.execution_claim_id = active.id and pa.executed_at is null and pa.cancelled_at is null and pa.expires_at > now()) into has_pending;
    if active.expires_at > now() or has_pending then
      return query select active.id, active.generation, false, active.holder_kind; return;
    end if;
    update public.conversation_execution_claims set superseded_at = now() where id = active.id;
  end if;
  insert into public.conversation_execution_claims (workspace_id, conversation_id, holder_kind, idempotency_key, triggering_message_id, reason, generation, expires_at)
  values (p_workspace_id, p_conversation_id, p_holder_kind, p_idempotency_key, p_triggering_message_id, p_reason, coalesce(active.generation, 0) + 1, now() + make_interval(secs => greatest(p_lease_seconds, 30)))
  returning id, conversation_execution_claims.generation into claim_id, generation;
  acquired := true; blocked_by := null; return next;
end $$;

create or replace function public.validate_conversation_execution(
  p_claim_id uuid,
  p_triggering_message_id uuid default null
) returns table(valid boolean, reason text)
language plpgsql security definer set search_path = public as $$
declare c public.conversation_execution_claims;
begin
  select * into c from public.conversation_execution_claims where id = p_claim_id for update;
  if not found or c.released_at is not null or c.completed_at is not null or c.superseded_at is not null then return query select false, 'claim_inactive'; return; end if;
  if p_triggering_message_id is not null then
    if exists(select 1 from public.unified_messages m where m.conversation_id = c.conversation_id and m.sender_type = 'customer' and not m.is_internal and m.sent_at > (select sent_at from public.unified_messages where id = p_triggering_message_id)) then return query select false, 'newer_customer_message'; return; end if;
    if exists(select 1 from public.conversation_response_executions r where r.inbound_message_id = p_triggering_message_id and r.claim_id <> c.id and r.completed_at is not null) then return query select false, 'already_answered'; return; end if;
    insert into public.conversation_response_executions (workspace_id, conversation_id, inbound_message_id, claim_id, disposition)
    values (c.workspace_id, c.conversation_id, p_triggering_message_id, c.id, 'reply') on conflict (inbound_message_id) do nothing;
    if not found then
      -- Same claim retry is safe: the common dispatch path additionally uses
      -- the inbound idempotency key and returns the persisted receipt. A
      -- different claim must yield rather than answer the same customer turn.
      if exists(select 1 from public.conversation_response_executions r where r.inbound_message_id = p_triggering_message_id and r.claim_id = c.id) then
        return query select true, null::text; return;
      end if;
      return query select false, 'inbound_reserved_by_other_execution'; return;
    end if;
  end if;
  return query select true, null::text;
end $$;

create or replace function public.complete_conversation_execution(p_claim_id uuid, p_outbound_message_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.conversation_execution_claims set completed_at = now() where id = p_claim_id and completed_at is null;
  update public.conversation_response_executions set outbound_message_id = p_outbound_message_id, completed_at = now() where claim_id = p_claim_id and completed_at is null;
end $$;

create or replace function public.release_conversation_execution(p_claim_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.conversation_execution_claims set released_at = now() where id = p_claim_id and completed_at is null and released_at is null
$$;

revoke all on function public.claim_conversation_execution(uuid, uuid, text, text, uuid, text, integer) from public;
revoke all on function public.validate_conversation_execution(uuid, uuid) from public;
revoke all on function public.complete_conversation_execution(uuid, uuid) from public;
revoke all on function public.release_conversation_execution(uuid) from public;
grant execute on function public.claim_conversation_execution(uuid, uuid, text, text, uuid, text, integer) to service_role;
grant execute on function public.validate_conversation_execution(uuid, uuid) to service_role;
grant execute on function public.complete_conversation_execution(uuid, uuid) to service_role;
grant execute on function public.release_conversation_execution(uuid) to service_role;
