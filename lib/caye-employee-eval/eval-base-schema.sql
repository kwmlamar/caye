-- Minimal production-shaped schema used only by Caye Employee Eval.
-- Candidate migrations are applied after this frozen base schema. This file is
-- intentionally not a production migration.

create table if not exists customers (
  id uuid primary key,
  business_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists connected_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references customers(id) on delete cascade,
  provider text not null default 'eval',
  created_at timestamptz not null default now()
);

create table if not exists unified_conversations (
  id uuid primary key default gen_random_uuid(),
  connected_account_id uuid not null references connected_accounts(id) on delete cascade,
  channel_type text not null,
  created_at timestamptz not null default now()
);

create table if not exists unified_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references unified_conversations(id) on delete cascade,
  sender_type text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  is_internal boolean not null default false,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists caye_operator_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references customers(id) on delete cascade,
  direction text not null,
  body text not null,
  operator_role text,
  operator_allowlist_id text,
  intent text,
  created_at timestamptz not null default now()
);

create table if not exists booking_services (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references customers(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists business_facts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references customers(id) on delete cascade,
  category text not null,
  fact text not null,
  source text not null,
  created_by text,
  service_id uuid,
  canonical_key text,
  expires_at timestamptz,
  memory_type text,
  subject_type text,
  subject_id uuid,
  knowledge_mode text,
  confidence numeric,
  valid_from timestamptz,
  sensitivity text,
  authority_kind text,
  provenance jsonb not null default '{}'::jsonb,
  contradicts_fact_id uuid,
  correction_of_fact_id uuid,
  superseded_at timestamptz,
  superseded_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists business_fact_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references customers(id) on delete cascade,
  normalized_text text not null,
  sample_text text not null,
  category_guess text,
  conversation_ids jsonb not null default '[]'::jsonb,
  occurrence_count integer not null default 1,
  status text not null default 'pending',
  source text not null,
  last_seen_at timestamptz not null default now(),
  outcome text,
  outcome_at timestamptz,
  resolved_fact_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists employee_eval_migration_state (
  migration_name text primary key,
  applied_at timestamptz not null default now()
);

create or replace function write_typed_business_memory_atomic(
  p_workspace_id uuid,
  p_category text,
  p_fact text,
  p_source text,
  p_created_by text,
  p_service_id uuid,
  p_canonical_key text,
  p_expires_at timestamptz,
  p_supersede_id uuid,
  p_memory_type text,
  p_subject_type text,
  p_subject_id uuid,
  p_knowledge_mode text,
  p_confidence numeric,
  p_valid_from timestamptz,
  p_sensitivity text,
  p_authority_kind text,
  p_provenance jsonb,
  p_contradicts_fact_id uuid,
  p_correction_of_fact_id uuid
)
returns table(id uuid, superseded_id uuid)
language plpgsql
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into business_facts (
    id, workspace_id, category, fact, source, created_by, service_id,
    canonical_key, expires_at, memory_type, subject_type, subject_id,
    knowledge_mode, confidence, valid_from, sensitivity, authority_kind,
    provenance, contradicts_fact_id, correction_of_fact_id
  ) values (
    v_id, p_workspace_id, p_category, p_fact, p_source, p_created_by,
    p_service_id, p_canonical_key, p_expires_at, p_memory_type,
    p_subject_type, p_subject_id, p_knowledge_mode, p_confidence,
    p_valid_from, p_sensitivity, p_authority_kind,
    coalesce(p_provenance, '{}'::jsonb), p_contradicts_fact_id,
    p_correction_of_fact_id
  );

  if p_supersede_id is not null then
    update business_facts
      set superseded_at = coalesce(p_valid_from, now()),
          superseded_by = v_id,
          updated_at = now()
      where business_facts.id = p_supersede_id
        and business_facts.workspace_id = p_workspace_id
        and superseded_at is null;
  end if;

  return query select v_id, p_supersede_id;
end;
$$;
