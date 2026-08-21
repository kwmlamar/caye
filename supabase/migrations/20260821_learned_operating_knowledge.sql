-- Issue #121 — durable operator corrections as reusable operating knowledge.
-- Additive and intentionally separate from objective business_facts: procedures
-- describe HOW to work; they never become evidence that a booking-specific fact
-- (time, driver, meeting point, price, etc.) is true.

create table if not exists public.learned_operating_knowledge (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  knowledge_type text not null check (knowledge_type in ('business_fact', 'procedure', 'operator_preference', 'constraint')),
  status text not null check (status in ('candidate', 'confirmed', 'active', 'superseded')),
  scope jsonb not null default '{}'::jsonb,
  trigger jsonb not null default '{}'::jsonb,
  behavior jsonb not null default '{}'::jsonb,
  rationale text,
  canonical_key text not null,
  confidence numeric(4,3) not null default 0.5 check (confidence >= 0 and confidence <= 1),
  evidence_count integer not null default 1 check (evidence_count > 0),
  risk_level text not null default 'low' check (risk_level in ('low', 'consequential')),
  source_operator_id bigint references public.operator_allowlist(id) on delete set null,
  source_message_id uuid references public.caye_operator_messages(id) on delete set null,
  source_conversation_id text,
  source_excerpt text not null,
  promotion_reason text,
  superseded_by uuid references public.learned_operating_knowledge(id) on delete set null,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists learned_operating_knowledge_active_workspace_idx
  on public.learned_operating_knowledge (workspace_id, canonical_key)
  where status = 'active' and superseded_at is null;
create index if not exists learned_operating_knowledge_candidate_workspace_idx
  on public.learned_operating_knowledge (workspace_id, canonical_key)
  where status in ('candidate', 'confirmed');
alter table public.learned_operating_knowledge enable row level security;

create table if not exists public.learned_operating_knowledge_audit (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.customers(id) on delete cascade,
  knowledge_id uuid references public.learned_operating_knowledge(id) on delete set null,
  event_type text not null check (event_type in ('correction_detected', 'candidate_created', 'promoted', 'rejected', 'conflict', 'superseded', 'retrieved', 'applied')),
  source_operator_id bigint references public.operator_allowlist(id) on delete set null,
  source_message_id uuid references public.caye_operator_messages(id) on delete set null,
  source_conversation_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists learned_operating_knowledge_audit_workspace_idx
  on public.learned_operating_knowledge_audit (workspace_id, created_at desc);
alter table public.learned_operating_knowledge_audit enable row level security;

-- One transaction closes candidate repetition and clean supersession. The
-- caller must have already verified operator authority and conflict semantics.
create or replace function public.record_operator_learning(
  p_workspace_id uuid, p_knowledge_type text, p_status text, p_scope jsonb,
  p_trigger jsonb, p_behavior jsonb, p_rationale text, p_canonical_key text,
  p_confidence numeric, p_risk_level text, p_source_operator_id bigint,
  p_source_message_id uuid, p_source_conversation_id text, p_source_excerpt text,
  p_promotion_reason text, p_supersede_id uuid default null
) returns public.learned_operating_knowledge
language plpgsql security definer set search_path = public as $$
declare v_row public.learned_operating_knowledge; v_existing public.learned_operating_knowledge;
begin
  if p_source_operator_id is null or not exists (
    select 1 from public.operator_allowlist o
    where o.id = p_source_operator_id and o.workspace_id = p_workspace_id
      and o.role in ('owner','staff','founder')
  ) then raise exception 'authorized workspace operator required'; end if;
  if p_risk_level = 'consequential' and p_status = 'active' then
    raise exception 'consequential learned knowledge cannot auto-promote';
  end if;
  -- Serialize matching corrections so two concurrent webhook deliveries do
  -- not create parallel candidates or both attempt a supersession.
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_canonical_key, 0));

  select * into v_existing from public.learned_operating_knowledge
   where workspace_id=p_workspace_id and canonical_key=p_canonical_key
     and status in ('candidate','confirmed') order by created_at desc limit 1 for update;
  if found then
    update public.learned_operating_knowledge set
      evidence_count=evidence_count+1,
      confidence=greatest(confidence,p_confidence),
      status=case when knowledge_type <> 'business_fact' and risk_level='low' and evidence_count+1 >= 2 and not exists (
        select 1 from public.learned_operating_knowledge a where a.workspace_id=p_workspace_id
          and a.canonical_key=p_canonical_key and a.status='active' and a.superseded_at is null
      ) then 'active' else status end,
      promotion_reason=case when knowledge_type <> 'business_fact' and risk_level='low' and evidence_count+1 >= 2 and not exists (
        select 1 from public.learned_operating_knowledge a where a.workspace_id=p_workspace_id
          and a.canonical_key=p_canonical_key and a.status='active' and a.superseded_at is null
      ) then 'repeated_matching_authorized_correction' else promotion_reason end,
      updated_at=now()
    where id=v_existing.id returning * into v_row;
  else
    insert into public.learned_operating_knowledge (
      workspace_id,knowledge_type,status,scope,trigger,behavior,rationale,canonical_key,
      confidence,risk_level,source_operator_id,source_message_id,source_conversation_id,
      source_excerpt,promotion_reason)
    values (p_workspace_id,p_knowledge_type,p_status,p_scope,p_trigger,p_behavior,p_rationale,
      p_canonical_key,p_confidence,p_risk_level,p_source_operator_id,p_source_message_id,
      p_source_conversation_id,p_source_excerpt,p_promotion_reason)
    returning * into v_row;
  end if;

  if p_supersede_id is not null then
    update public.learned_operating_knowledge set status='superseded', superseded_by=v_row.id,
      superseded_at=now(), updated_at=now()
    where id=p_supersede_id and workspace_id=p_workspace_id and status='active' and superseded_at is null;
    if not found then raise exception 'active same-workspace supersession target required'; end if;
  end if;
  return v_row;
end $$;
revoke all on function public.record_operator_learning(uuid,text,text,jsonb,jsonb,jsonb,text,text,numeric,text,bigint,uuid,text,text,text,uuid) from public, anon, authenticated;
grant execute on function public.record_operator_learning(uuid,text,text,jsonb,jsonb,jsonb,text,text,numeric,text,bigint,uuid,text,text,text,uuid) to service_role;
