-- unified_messages.status uses message_delivery_status, whose durable
-- pre-provider state is `sending` (not the historical text value `pending`).
-- Replace both ends of the recovery delivery transition together.
create or replace function public.sales_prepare_stale_hold_recovery_delivery(
  p_recovery_id uuid, p_workspace_id uuid, p_subject text, p_body text, p_sent_at timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_recovery public.sales_stale_hold_recoveries%rowtype; v_outbound_id uuid; v_inbound_at timestamptz; v_safe boolean;
begin
  select * into v_recovery from public.sales_stale_hold_recoveries
    where id = p_recovery_id and workspace_id = p_workspace_id for update;
  if not found or v_recovery.status <> 'claimed' then raise exception 'recovery is not available for delivery'; end if;
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
    select 1 from public.unified_conversations c where c.id = v_recovery.conversation_id
      and c.human_agent_enabled = true and c.human_agent_reason = v_recovery.stale_hold_reason
  ) into v_safe;
  if not v_safe then raise exception 'recovery was superseded before delivery'; end if;
  insert into public.unified_messages (
    conversation_id, channel_message_id, sender_type, sender_attribution, content,
    message_type, sent_at, status, metadata
  ) values (
    v_recovery.conversation_id, 'caye_recovery_' || v_recovery.id::text,
    'business', 'caye_autopilot', p_body, 'text', p_sent_at, 'sending',
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

create or replace function public.sales_complete_stale_hold_recovery(
  p_recovery_id uuid, p_workspace_id uuid, p_sent_at timestamptz, p_provider_message_id text
) returns text language plpgsql security definer set search_path = public as $$
declare v_recovery public.sales_stale_hold_recoveries%rowtype; v_inbound_at timestamptz; v_safe boolean; v_outbound public.unified_messages%rowtype;
begin
  select * into v_recovery from public.sales_stale_hold_recoveries
    where id = p_recovery_id and workspace_id = p_workspace_id for update;
  if not found or v_recovery.status <> 'delivery_attempting' then raise exception 'recovery is not completing'; end if;
  if p_provider_message_id is null or length(trim(p_provider_message_id)) = 0 then raise exception 'provider message id is required to complete recovery'; end if;
  select * into v_outbound from public.unified_messages
    where id = v_recovery.outbound_message_id and conversation_id = v_recovery.conversation_id
      and status = 'sending' for update;
  if not found then raise exception 'recovery outbound is not sending'; end if;
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
    select 1 from public.unified_conversations c where c.id = v_recovery.conversation_id
      and c.human_agent_enabled = true and c.human_agent_reason = v_recovery.stale_hold_reason
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
