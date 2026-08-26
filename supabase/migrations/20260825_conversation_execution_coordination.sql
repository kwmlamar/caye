-- One durable customer-facing execution owner per conversation.  This is a
-- process boundary, not a UI hint: webhook, cron, operator and dashboard
-- workers all meet here before they can dispatch to a customer.
--
-- ============================================================================
-- STATE MACHINE (both tables below are governed by this)
-- ============================================================================
--
-- conversation_execution_claims.<terminal columns>: at most ONE of
-- completed_at / released_at / superseded_at is ever set, and once set it is
-- never unset (crash points 1-5 below all resolve into exactly one of these,
-- never back into "active"):
--
--   created (active: all three terminal columns null)
--     -> completed_at set        -- a customer-facing send happened under
--                                    this claim (or is certain to have
--                                    happened — see DispatchAmbiguousError
--                                    doc comment in channel-dispatch.ts).
--                                    PERMANENT: complete_conversation_execution
--                                    only ever sets this once (`where
--                                    completed_at is null`).
--     -> released_at set         -- concluded with NO customer-facing send
--                                    and no ambiguity: safe for a later
--                                    execution to retry the same work.
--     -> superseded_at set       -- a higher-authority claim (operator/human)
--                                    took over the conversation before this
--                                    claim reached provider dispatch. Its
--                                    NEXT validate_conversation_execution
--                                    call (the one immediately before it
--                                    would otherwise send) fails closed.
--
-- A claim never both completes AND releases/supersedes — every RPC below
-- guards its UPDATE with `where completed_at is null` (or the equivalent),
-- so whichever terminal state lands first wins and the others become no-ops.
--
-- conversation_response_executions (one row reserves one customer inbound
-- turn against being answered twice — only created when a claim validates
-- WITH a triggering_message_id, i.e. "this claim is about to answer this
-- specific customer message"):
--
--   reserved (created: completed_at / abandoned_at / send_uncertain_at all
--             null) -- inserted by validate_conversation_execution,
--                       immediately before the caller's provider dispatch
--                       attempt.
--     -> completed_at set        -- dispatch confirmed (or certain — see
--                                    above). PERMANENT: blocks every future
--                                    claim from ever reserving this same
--                                    inbound_message_id again
--                                    (already_answered).
--     -> abandoned_at set        -- dispatch is CERTAIN not to have reached
--                                    the provider (the failure happened
--                                    before any provider call was attempted).
--                                    The partial unique index below excludes
--                                    abandoned rows, so a LATER claim may
--                                    reserve and answer the same inbound
--                                    turn — this is the crash-point-1/2/3
--                                    resolution ("failed before send").
--     -> send_uncertain_at set   -- dispatch outcome is NOT knowable (the
--                                    provider call itself threw, or the
--                                    provider accepted but our own receipt
--                                    persistence failed and we are choosing
--                                    to require reconciliation rather than
--                                    assume success — see the two call
--                                    sites' comments for which path each
--                                    takes). PERMANENT and NEVER
--                                    auto-retried: still occupies the
--                                    partial unique index slot, so no other
--                                    claim can answer this inbound turn
--                                    until a human reconciles it. This is
--                                    the crash-point-4 resolution ("provider
--                                    accepted, process died before
--                                    persistence") — fail closed rather than
--                                    silently erasing the ambiguity.
--
-- Crash points, resolved:
--   1. after claim insert, before validate       -> claim stays active,
--        picked up again by retry (same idempotency key) or eventually
--        reclaimed once its lease expires with nothing pending on it.
--   2. after response reservation, before dispatch attempted
--        -> definite non-send on abandon; see abandon_conversation_execution_response.
--   3. immediately before provider call            -> same as 2 if the
--        calling code never got far enough to invoke the provider.
--   4. provider accepted but process dies before persistence
--        -> DispatchAmbiguousError(definitelySent: false) from the
--        provider-call site itself is indistinguishable from this at the
--        network layer, so both route to send_uncertain_at (fail closed).
--        DispatchAmbiguousError(definitelySent: true) (the provider call
--        RETURNED, only our OWN bookkeeping afterward failed) is the one
--        case we're certain about — that routes to completed_at, not
--        send_uncertain_at.
--   5. persistence succeeds but claim completion RPC call itself fails
--        -> the response-execution row was already inserted (reserved) and
--        will very likely still get its completed_at via the normal
--        complete_conversation_execution retry/best-effort call; if that
--        never lands, "reserved forever" (no completed_at, no
--        abandoned_at) is ALSO safe — it still occupies the partial unique
--        index slot and blocks a second answer, identically to
--        send_uncertain_at. No special handling needed.
-- ============================================================================
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
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists conversation_execution_one_active_claim
  on public.conversation_execution_claims (conversation_id)
  where released_at is null and completed_at is null and superseded_at is null;
create index if not exists conversation_execution_trigger_idx
  on public.conversation_execution_claims (conversation_id, triggering_message_id);
-- NOT unique: an idempotency key identifies one LOGICAL execution, but once
-- that execution reaches a terminal state (any of the three), the SAME key
-- is legitimately reused to mint the next generation (see
-- claim_conversation_execution's comment on `existing_key`). A plain index
-- is enough — claim_conversation_execution is the only writer, and it always
-- takes `for update` row locks before deciding, so races serialize there
-- rather than needing a DB constraint to catch them.
create index if not exists conversation_execution_idempotency_idx
  on public.conversation_execution_claims (workspace_id, conversation_id, idempotency_key);

-- Durable one-response-per-customer-turn relationship.  A provider receipt
-- is filled in after dispatch; the partial unique index below stops a
-- second worker from deciding it can answer the same turn, UNLESS the prior
-- reservation was explicitly abandoned as a certain non-send.
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
  -- Certain non-send: safe for a later claim to reserve+answer this same
  -- inbound_message_id. Excluded from the partial unique index below.
  abandoned_at timestamptz,
  -- Uncertain outcome (provider call threw, or accepted-but-unpersisted):
  -- deliberately NOT excluded from the partial unique index. Requires
  -- manual reconciliation; never auto-retried.
  send_uncertain_at timestamptz
);

create unique index if not exists conversation_response_executions_one_live_reservation
  on public.conversation_response_executions (inbound_message_id)
  where abandoned_at is null;

alter table public.caye_pending_actions
  add column if not exists execution_claim_id uuid references public.conversation_execution_claims(id) on delete set null;

alter table public.conversation_execution_claims enable row level security;
alter table public.conversation_response_executions enable row level security;

-- Claims use a row lock on the canonical conversation. Deterministic holder
-- precedence: an explicit human/operator-directed claim (human_manual,
-- operator_caye, correction_followup — "tier 2") supersedes an active
-- autonomous/scheduled claim (autonomous_frontdesk, scheduled_system —
-- "tier 1") OUTRIGHT, regardless of lease expiry or pending work — an
-- authorized person's instruction always outranks Caye acting on her own.
-- Same-or-lower-tier claims keep the original conservative rule: blocked
-- while the active claim's lease is live, or while an operator-confirmable
-- action still references it, even past lease expiry (an unconfirmed draft
-- is durable proof someone is still mid-decision).
--
-- Superseding a claim here does NOT retroactively cancel a provider call
-- that claim already made — nothing can. It only guarantees that claim's
-- NEXT validate_conversation_execution call (the mandatory last gate before
-- ITS provider dispatch) fails closed, so a stale worker can supersede-race
-- right up until the moment it actually dispatches, never after.
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
  existing_key public.conversation_execution_claims;
  existing_key_found boolean;
  active public.conversation_execution_claims;
  active_found boolean;
  has_pending boolean;
  new_tier int;
  active_tier int;
  base_generation bigint;
begin
  perform 1 from public.unified_conversations where id = p_conversation_id for update;

  -- Lock whatever row currently owns this exact idempotency key (in ANY
  -- lifecycle state), so two concurrent callers using the same key always
  -- serialize on this one row instead of racing an insert.
  select * into existing_key from public.conversation_execution_claims
   where workspace_id = p_workspace_id and conversation_id = p_conversation_id and idempotency_key = p_idempotency_key
   order by claimed_at desc limit 1 for update;
  existing_key_found := found;

  if existing_key_found
     and existing_key.released_at is null
     and existing_key.completed_at is null
     and existing_key.superseded_at is null then
    -- Still genuinely active: the common concurrent-retry case (a webhook
    -- redelivered while the first attempt is still running) or the same
    -- caller re-acquiring mid-session. Reuse directly.
    return query select existing_key.id, existing_key.generation, true, null::text; return;
  end if;
  -- Any terminal state for this key (completed, released, or superseded)
  -- means that specific execution is over. Fall through and mint a NEW
  -- generation under the SAME key rather than reusing stale history — this
  -- is what lets a long-lived key (e.g. the same operator drafting many
  -- separate replies to the same conversation over time) start fresh each
  -- time instead of colliding with its own earlier, now-irrelevant row.
  -- Whether an actual duplicate customer-facing send can happen is decided
  -- later and independently, at validate_conversation_execution (via the
  -- response-execution reservation) and at each call site's own dispatch
  -- idempotency key — not here.

  select * into active from public.conversation_execution_claims
   where conversation_id = p_conversation_id and released_at is null and completed_at is null and superseded_at is null
   order by claimed_at desc limit 1 for update;
  active_found := found;

  new_tier := case when p_holder_kind in ('human_manual', 'operator_caye', 'correction_followup') then 2 else 1 end;
  -- Monotonic for the LIFE OF THE CONVERSATION, not just "whatever's
  -- currently active" — otherwise a full release-then-reacquire cycle (with
  -- nothing else claiming in between) would reset the counter back down,
  -- making it useless as an audit trail of how many claims a conversation
  -- has ever seen.
  select coalesce(max(conversation_execution_claims.generation), 0) into base_generation
    from public.conversation_execution_claims where conversation_id = p_conversation_id;

  if active_found then
    if active.workspace_id <> p_workspace_id then raise exception 'conversation workspace mismatch'; end if;

    if active.idempotency_key = p_idempotency_key then
      -- Unreachable in practice: an active row sharing this exact key would
      -- already have matched existing_key above and returned. Kept as a
      -- defensive fallback so this function can never insert a duplicate
      -- active claim for one key.
      return query select active.id, active.generation, true, null::text; return;
    end if;

    active_tier := case when active.holder_kind in ('human_manual', 'operator_caye', 'correction_followup') then 2 else 1 end;

    if new_tier > active_tier then
      update public.conversation_execution_claims set superseded_at = now() where id = active.id;
    else
      select exists(
        select 1 from public.caye_pending_actions pa
         where pa.execution_claim_id = active.id and pa.executed_at is null and pa.cancelled_at is null and pa.expires_at > now()
      ) into has_pending;
      if active.expires_at > now() or has_pending then
        return query select active.id, active.generation, false, active.holder_kind; return;
      end if;
      update public.conversation_execution_claims set superseded_at = now() where id = active.id;
    end if;
  end if;

  insert into public.conversation_execution_claims (workspace_id, conversation_id, holder_kind, idempotency_key, triggering_message_id, reason, generation, expires_at)
  values (p_workspace_id, p_conversation_id, p_holder_kind, p_idempotency_key, p_triggering_message_id, p_reason, base_generation + 1, now() + make_interval(secs => greatest(p_lease_seconds, 30)))
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
    values (c.workspace_id, c.conversation_id, p_triggering_message_id, c.id, 'reply')
    on conflict (inbound_message_id) where abandoned_at is null do nothing;
    if not found then
      -- Same claim retry is safe: the common dispatch path additionally uses
      -- the inbound idempotency key and returns the persisted receipt. A
      -- different claim must yield rather than answer the same customer
      -- turn — including while the existing reservation is merely
      -- send_uncertain (ambiguous outcomes are never auto-retried, by ANY
      -- claim, until a human reconciles them).
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
  update public.conversation_response_executions set outbound_message_id = p_outbound_message_id, completed_at = now() where claim_id = p_claim_id and completed_at is null and abandoned_at is null;
end $$;

create or replace function public.release_conversation_execution(p_claim_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.conversation_execution_claims set released_at = now() where id = p_claim_id and completed_at is null and released_at is null
$$;

-- Certain non-send: the caller knows for a fact its provider call was never
-- attempted (or was rejected before any external side effect — see
-- DispatchAmbiguousError in lib/whatsapp/channel-dispatch.ts). Frees the
-- inbound turn for a later execution AND releases the claim in one atomic
-- call, so a caller never leaves one done without the other.
create or replace function public.abandon_conversation_execution_response(p_claim_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.conversation_response_executions
     set abandoned_at = now()
   where claim_id = p_claim_id and completed_at is null and abandoned_at is null and send_uncertain_at is null;
  update public.conversation_execution_claims
     set released_at = now()
   where id = p_claim_id and completed_at is null and released_at is null;
end $$;

-- Uncertain outcome: the caller cannot tell whether the provider accepted
-- the send. Marks the reservation (if any) so it stays permanently blocking
-- — never erased, never auto-retried, discoverable for manual reconciliation
-- — and releases the claim so the CONVERSATION itself isn't stuck, even
-- though this specific inbound turn is.
create or replace function public.mark_conversation_execution_ambiguous(p_claim_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.conversation_response_executions
     set send_uncertain_at = now()
   where claim_id = p_claim_id and completed_at is null and abandoned_at is null and send_uncertain_at is null;
  update public.conversation_execution_claims
     set released_at = now()
   where id = p_claim_id and completed_at is null and released_at is null;
end $$;

revoke all on function public.claim_conversation_execution(uuid, uuid, text, text, uuid, text, integer) from public;
revoke all on function public.validate_conversation_execution(uuid, uuid) from public;
revoke all on function public.complete_conversation_execution(uuid, uuid) from public;
revoke all on function public.release_conversation_execution(uuid) from public;
revoke all on function public.abandon_conversation_execution_response(uuid) from public;
revoke all on function public.mark_conversation_execution_ambiguous(uuid) from public;
grant execute on function public.claim_conversation_execution(uuid, uuid, text, text, uuid, text, integer) to service_role;
grant execute on function public.validate_conversation_execution(uuid, uuid) to service_role;
grant execute on function public.complete_conversation_execution(uuid, uuid) to service_role;
grant execute on function public.release_conversation_execution(uuid) to service_role;
grant execute on function public.abandon_conversation_execution_response(uuid) to service_role;
grant execute on function public.mark_conversation_execution_ambiguous(uuid) to service_role;
