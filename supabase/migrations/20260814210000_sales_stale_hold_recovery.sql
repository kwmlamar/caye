-- Explicit, operator-authorized recovery for a Sales inbound that was held by
-- the pre-Sales-autonomy quote guard. This is deliberately not a sweep: an
-- operator must name the canonical inbound message to recover.
create table if not exists public.sales_stale_hold_recoveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  conversation_id uuid not null references public.unified_conversations(id) on delete cascade,
  original_message_id uuid not null references public.unified_messages(id) on delete restrict,
  operator_allowlist_id bigint not null,
  stale_hold_reason text not null,
  status text not null check (status in ('claimed', 'blocked', 'delivery_attempting', 'delivery_unknown', 'sent', 'sent_hold_preserved')),
  outbound_message_id uuid references public.unified_messages(id) on delete restrict,
  generated_content text,
  claimed_at timestamptz not null default now(),
  delivery_attempted_at timestamptz,
  completed_at timestamptz,
  failure_reason text,
  unique (original_message_id),
  unique (workspace_id, id),
  foreign key (workspace_id, operator_allowlist_id)
    references public.operator_allowlist(workspace_id, id) on delete restrict
);

alter table public.sales_stale_hold_recoveries enable row level security;

-- The stale reason is intentionally a narrow allow-list. Add a reason only
-- after its historical behaviour has been audited; this function is not a
-- general "unhold and retry" bypass.
create or replace function public.sales_claim_stale_hold_recovery(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_original_message_id uuid,
  p_operator_allowlist_id bigint
) returns table (recovery_id uuid, status text)
language plpgsql security definer set search_path = public as $$
declare
  v_existing public.sales_stale_hold_recoveries%rowtype;
  v_conversation public.unified_conversations%rowtype;
  v_inbound public.unified_messages%rowtype;
begin
  perform 1 from public.operator_allowlist
    where id = p_operator_allowlist_id and workspace_id = p_workspace_id
      and role in ('owner', 'founder');
  if not found then raise exception 'operator is not authorized for stale Sales hold recovery'; end if;

  select c.* into v_conversation
    from public.unified_conversations c
    join public.connected_accounts ca on ca.id = c.connected_account_id
    where c.id = p_conversation_id and ca.user_id = p_workspace_id for update of c;
  if not found then raise exception 'conversation is not in workspace'; end if;
  if v_conversation.human_agent_enabled is distinct from true
     or v_conversation.human_agent_reason <> 'quote_without_database_price' then
    raise exception 'conversation is not held for the recoverable stale reason';
  end if;

  select * into v_inbound from public.unified_messages
    where id = p_original_message_id and conversation_id = p_conversation_id
      and sender_type = 'customer' and is_internal is distinct from true for update;
  if not found then raise exception 'original message is not a canonical customer inbound'; end if;

  -- Authorize workspace and canonical message ownership before exposing even
  -- the existence of a prior receipt. A cross-workspace caller must receive
  -- the same rejection whether this inbound was recovered before or not.
  select * into v_existing from public.sales_stale_hold_recoveries
    where original_message_id = p_original_message_id for update;
  -- An existing claimed row is in progress, not permission for a second
  -- worker to generate/send. Returning a distinct status makes the caller
  -- fail closed on concurrent clicks and retries.
  if found then return query select v_existing.id, 'already_' || v_existing.status; return; end if;

  -- A later customer turn supersedes this one. A human-authored public reply
  -- means the operator has already taken responsibility for the turn. Caye's
  -- old acknowledgement is deliberately not classified as human evidence.
  if exists (
    select 1 from public.unified_messages m
      where m.conversation_id = p_conversation_id and m.sent_at > v_inbound.sent_at
        and m.sender_type = 'customer' and m.is_internal is distinct from true
  ) then raise exception 'a later customer inbound supersedes the recovery'; end if;
  if exists (
    select 1 from public.unified_messages m
      where m.conversation_id = p_conversation_id and m.sent_at >= v_inbound.sent_at
        and m.sender_type = 'business' and m.is_internal is distinct from true
        and (m.sender_attribution in ('human_via_external', 'human_via_caye')
          or m.metadata->>'sent_by' = 'human' or m.metadata->>'source' = 'zoho_sent')
  ) then raise exception 'a human reply prevents recovery'; end if;

  insert into public.sales_stale_hold_recoveries
    (workspace_id, conversation_id, original_message_id, operator_allowlist_id, stale_hold_reason, status)
  values (p_workspace_id, p_conversation_id, p_original_message_id, p_operator_allowlist_id,
          'quote_without_database_price', 'claimed')
  on conflict (original_message_id) do nothing
  returning id, sales_stale_hold_recoveries.status into recovery_id, status;
  if recovery_id is null then
    select * into v_existing from public.sales_stale_hold_recoveries
      where original_message_id = p_original_message_id;
    return query select v_existing.id, 'already_' || v_existing.status;
    return;
  end if;
  return next;
end;
$$;

-- This is a narrowly-scoped authorization for the existing generator's hold
-- gate. It never affects provider inbound claims and it is valid only while a
-- recovery is still claimed for this exact stored inbound.
create or replace function public.sales_stale_hold_recovery_can_generate(
  p_recovery_id uuid, p_workspace_id uuid, p_conversation_id uuid, p_original_message_id uuid
) returns boolean
language sql security definer set search_path = public as $$
  select exists (
    select 1 from public.sales_stale_hold_recoveries r
      where r.id = p_recovery_id and r.workspace_id = p_workspace_id
        and r.conversation_id = p_conversation_id and r.original_message_id = p_original_message_id
        and r.status = 'claimed'
  )
$$;

-- Persist the exact reply and enter an intentionally non-retryable provider
-- attempt state in one transaction. The hold remains set until a confirmed
-- provider success; a process crash therefore fails closed rather than
-- sending a second customer email on retry.
create or replace function public.sales_prepare_stale_hold_recovery_delivery(
  p_recovery_id uuid, p_workspace_id uuid, p_subject text, p_body text, p_sent_at timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_recovery public.sales_stale_hold_recoveries%rowtype; v_outbound_id uuid; v_inbound_at timestamptz; v_safe boolean;
begin
  select * into v_recovery from public.sales_stale_hold_recoveries
    where id = p_recovery_id and workspace_id = p_workspace_id for update;
  if not found or v_recovery.status <> 'claimed' then
    raise exception 'recovery is not available for delivery';
  end if;
  select sent_at into v_inbound_at from public.unified_messages
    where id = v_recovery.original_message_id for update;
  perform 1 from public.unified_conversations where id = v_recovery.conversation_id for update;
  -- Generation can take time. Recheck the same authoritative turn boundary
  -- immediately before creating an outbound/send attempt.
  select not exists (
    select 1 from public.unified_messages m where m.conversation_id = v_recovery.conversation_id
      and m.sent_at > v_inbound_at and m.sender_type = 'customer' and m.is_internal is distinct from true
  ) and not exists (
    select 1 from public.unified_messages m where m.conversation_id = v_recovery.conversation_id
      and m.sent_at >= v_inbound_at and m.sender_type = 'business' and m.is_internal is distinct from true
      and (m.sender_attribution in ('human_via_external', 'human_via_caye')
        or m.metadata->>'sent_by' = 'human' or m.metadata->>'source' = 'zoho_sent')
  ) and exists (
    select 1 from public.unified_conversations c where c.id = v_recovery.conversation_id
      and c.human_agent_enabled = true and c.human_agent_reason = v_recovery.stale_hold_reason
  ) into v_safe;
  if not v_safe then raise exception 'recovery was superseded before delivery'; end if;
  insert into public.unified_messages (
    conversation_id, channel_message_id, sender_type, sender_attribution, content,
    message_type, sent_at, status, metadata
  ) values (
    v_recovery.conversation_id, 'caye_recovery_' || v_recovery.id::text,
    'business', 'caye_autopilot', p_body, 'text', p_sent_at, 'pending',
    jsonb_build_object('subject', p_subject, 'is_automated', true, 'generated_by', 'caye',
      'triggered_by', 'sales-stale-hold-recovery', 'recovery_id', v_recovery.id,
      'original_message_id', v_recovery.original_message_id)
  ) returning id into v_outbound_id;
  update public.sales_stale_hold_recoveries
    set status = 'delivery_attempting', outbound_message_id = v_outbound_id,
        generated_content = p_body, delivery_attempted_at = now()
    where id = v_recovery.id;
  return v_outbound_id;
end;
$$;

-- No retry after an uncertain provider call. The original hold was never
-- released, so this state safely asks an operator to resolve delivery.
create or replace function public.sales_mark_stale_hold_recovery_unknown(
  p_recovery_id uuid, p_workspace_id uuid, p_reason text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.sales_stale_hold_recoveries
    set status = 'delivery_unknown', failure_reason = p_reason
    where id = p_recovery_id and workspace_id = p_workspace_id
      and status = 'delivery_attempting';
end;
$$;

create or replace function public.sales_block_stale_hold_recovery(
  p_recovery_id uuid, p_workspace_id uuid, p_reason text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.sales_stale_hold_recoveries
    set status = 'blocked', failure_reason = p_reason
    where id = p_recovery_id and workspace_id = p_workspace_id and status = 'claimed';
end;
$$;

-- Confirm delivery then release only the same stale hold, after rechecking
-- that no later customer or human turn arrived during generation/send.
create or replace function public.sales_complete_stale_hold_recovery(
  p_recovery_id uuid, p_workspace_id uuid, p_sent_at timestamptz, p_provider_message_id text
) returns text language plpgsql security definer set search_path = public as $$
declare v_recovery public.sales_stale_hold_recoveries%rowtype; v_inbound_at timestamptz; v_safe boolean; v_outbound public.unified_messages%rowtype;
begin
  select * into v_recovery from public.sales_stale_hold_recoveries
    where id = p_recovery_id and workspace_id = p_workspace_id for update;
  if not found or v_recovery.status <> 'delivery_attempting' then raise exception 'recovery is not completing'; end if;
  if p_provider_message_id is null or length(trim(p_provider_message_id)) = 0 then
    raise exception 'provider message id is required to complete recovery';
  end if;
  select * into v_outbound from public.unified_messages
    where id = v_recovery.outbound_message_id and conversation_id = v_recovery.conversation_id
      and status = 'pending' for update;
  if not found then raise exception 'recovery outbound is not pending'; end if;
  select sent_at into v_inbound_at from public.unified_messages where id = v_recovery.original_message_id for update;
  perform 1 from public.unified_conversations where id = v_recovery.conversation_id for update;
  select not exists (
    select 1 from public.unified_messages m where m.conversation_id = v_recovery.conversation_id
      and m.sent_at > v_inbound_at and m.sender_type = 'customer' and m.is_internal is distinct from true
  ) and not exists (
    select 1 from public.unified_messages m where m.conversation_id = v_recovery.conversation_id
      and m.sent_at >= v_inbound_at and m.sender_type = 'business' and m.is_internal is distinct from true
      and (m.sender_attribution in ('human_via_external', 'human_via_caye')
        or m.metadata->>'sent_by' = 'human' or m.metadata->>'source' = 'zoho_sent')
  ) and exists (
    select 1 from public.unified_conversations c
      where c.id = v_recovery.conversation_id and c.human_agent_enabled = true
        and c.human_agent_reason = v_recovery.stale_hold_reason
  ) into v_safe;
  update public.unified_messages set status = 'sent', sent_at = p_sent_at,
    metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{zoho_message_id}', to_jsonb(p_provider_message_id), true)
    where id = v_recovery.outbound_message_id;
  if v_safe then
    update public.unified_conversations set human_agent_enabled = false, human_agent_reason = null,
      last_sender_type = 'business', last_business_sender_kind = 'caye', last_message_at = p_sent_at,
      last_message_preview = left(v_recovery.generated_content, 100)
      where id = v_recovery.conversation_id and human_agent_enabled = true
        and human_agent_reason = v_recovery.stale_hold_reason;
    update public.sales_stale_hold_recoveries set status = 'sent', completed_at = now() where id = v_recovery.id;
    return 'sent';
  end if;
  update public.sales_stale_hold_recoveries set status = 'sent_hold_preserved', completed_at = now(),
    failure_reason = 'a newer customer or human turn arrived before completion' where id = v_recovery.id;
  return 'sent_hold_preserved';
end;
$$;

revoke all on function public.sales_claim_stale_hold_recovery(uuid, uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.sales_stale_hold_recovery_can_generate(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.sales_prepare_stale_hold_recovery_delivery(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.sales_mark_stale_hold_recovery_unknown(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.sales_block_stale_hold_recovery(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.sales_complete_stale_hold_recovery(uuid, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.sales_claim_stale_hold_recovery(uuid, uuid, uuid, bigint) to service_role;
grant execute on function public.sales_stale_hold_recovery_can_generate(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.sales_prepare_stale_hold_recovery_delivery(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.sales_mark_stale_hold_recovery_unknown(uuid, uuid, text) to service_role;
grant execute on function public.sales_block_stale_hold_recovery(uuid, uuid, text) to service_role;
grant execute on function public.sales_complete_stale_hold_recovery(uuid, uuid, timestamptz, text) to service_role;
