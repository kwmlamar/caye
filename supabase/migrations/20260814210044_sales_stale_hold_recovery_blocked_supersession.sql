-- A blocked recovery that never reached provider delivery may be explicitly
-- superseded. Delivery-related states remain terminal: there is no safe way
-- to distinguish a retry from a duplicate provider send after preparation.
alter table public.sales_stale_hold_recoveries
  add column recovery_attempt integer not null default 1 check (recovery_attempt > 0);

alter table public.sales_stale_hold_recoveries
  drop constraint sales_stale_hold_recoveries_original_message_id_key;

alter table public.sales_stale_hold_recoveries
  add constraint sales_stale_hold_recoveries_original_message_id_attempt_key
  unique (original_message_id, recovery_attempt);

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
  v_next_attempt integer := 1;
begin
  perform 1 from public.operator_allowlist
    where id = p_operator_allowlist_id and workspace_id = p_workspace_id
      and role in ('owner', 'founder');
  if not found then raise exception 'operator is not authorized for stale Sales hold recovery'; end if;

  select c.* into v_conversation from public.unified_conversations c
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

  select * into v_existing from public.sales_stale_hold_recoveries
    where original_message_id = p_original_message_id
    order by recovery_attempt desc limit 1 for update;
  if found then
    -- Only a pre-delivery block is supersedable. Never retry a state that
    -- created an outbound record or might have contacted the provider.
    if v_existing.status <> 'blocked'
       or v_existing.outbound_message_id is not null
       or v_existing.delivery_attempted_at is not null then
      return query select v_existing.id, 'already_' || v_existing.status;
      return;
    end if;
    v_next_attempt := v_existing.recovery_attempt + 1;
  end if;

  if exists (
    select 1 from public.unified_messages m
      where m.conversation_id = p_conversation_id and m.sent_at > v_inbound.sent_at
        and m.sender_type = 'customer' and m.is_internal is distinct from true
  ) then raise exception 'a later customer message supersedes recovery'; end if;
  if exists (
    select 1 from public.unified_messages m
      where m.conversation_id = p_conversation_id and m.sent_at >= v_inbound.sent_at
        and m.sender_type = 'business' and m.is_internal is distinct from true
        and (m.sender_attribution in ('human_via_external', 'human_via_caye')
          or m.metadata->>'sent_by' = 'human' or m.metadata->>'source' = 'zoho_sent')
  ) then raise exception 'a human reply prevents recovery'; end if;

  insert into public.sales_stale_hold_recoveries
    (workspace_id, conversation_id, original_message_id, operator_allowlist_id,
     stale_hold_reason, status, recovery_attempt)
  values (p_workspace_id, p_conversation_id, p_original_message_id,
          p_operator_allowlist_id, 'quote_without_database_price', 'claimed', v_next_attempt)
  on conflict (original_message_id, recovery_attempt) do nothing
  returning id, sales_stale_hold_recoveries.status into recovery_id, status;
  if recovery_id is null then
    select * into v_existing from public.sales_stale_hold_recoveries
      where original_message_id = p_original_message_id
      order by recovery_attempt desc limit 1;
    return query select v_existing.id, 'already_' || v_existing.status;
    return;
  end if;
  return next;
end;
$$;

revoke all on function public.sales_claim_stale_hold_recovery(uuid, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.sales_claim_stale_hold_recovery(uuid, uuid, uuid, bigint) to service_role;
