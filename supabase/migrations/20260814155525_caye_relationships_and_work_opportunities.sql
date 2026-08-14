-- Phase 2: generic Caye coordination state, deliberately stopping before
-- authorization, jobs, execution, or results. Contacts remain the canonical
-- counterparty identity; outreach_leads remains Sales acquisition state.
-- DEPLOYMENT ORDER: apply this migration before application code that calls
-- caye_resolve_relationship or caye_record_work_opportunity.

-- The composite key is required so every relationship can prove its contact
-- belongs to the same workspace in the database, not just in application code.
create unique index if not exists contacts_customer_id_id_unique_idx
  on public.contacts (customer_id, id);

create table if not exists public.caye_relationships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  -- `contact` is the only canonical counterparty supported today. A future
  -- business registry can add another type without turning lead metadata into
  -- a second identity store.
  counterparty_type text not null default 'contact'
    check (counterparty_type in ('contact')),
  -- Keep the historical relationship/work trail if canonical contact identity
  -- is later removed. The reference becomes null; it never crosses workspace.
  contact_id uuid,
  originating_capability text,
  external_subject_ref text,
  relationship_state text not null default 'prospect'
    check (relationship_state in ('prospect', 'engaged', 'client', 'inactive')),
  meaningful_interaction_started_at timestamptz,
  last_meaningful_interaction_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, contact_id),
  unique (workspace_id, id),
  foreign key (workspace_id, contact_id)
    references public.contacts(customer_id, id) on delete set null (contact_id)
);

create unique index if not exists caye_relationships_external_subject_idx
  on public.caye_relationships (workspace_id, external_subject_ref)
  where external_subject_ref is not null;

create index if not exists caye_relationships_workspace_state_idx
  on public.caye_relationships (workspace_id, relationship_state, last_meaningful_interaction_at desc);

comment on table public.caye_relationships is
  'Caye/workspace relationship to one canonical counterparty. Not a contact copy and not Sales lifecycle state. Phase 2 creates prospect/engaged only; client is reserved for Phase 3 authorization.';

create table if not exists public.caye_work_opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  relationship_id uuid not null,
  -- Origin is intentionally open text: Sales is only the first current
  -- producer; future capabilities must not require a schema rewrite.
  originating_capability text not null,
  opportunity_type text not null,
  capability_key text not null,
  -- Stable subject identity, not generated prose. Distinct subjects remain
  -- distinct opportunities for the same relationship.
  subject_key text not null,
  description text not null,
  inference text not null,
  confidence text not null check (confidence in ('medium', 'high')),
  status text not null default 'observed'
    check (status in ('observed', 'dismissed', 'stale')),
  external_subject_ref text,
  discovered_at timestamptz not null default now(),
  last_evidenced_at timestamptz not null default now(),
  materially_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, relationship_id, originating_capability, opportunity_type, subject_key),
  unique (workspace_id, id),
  foreign key (workspace_id, relationship_id)
    references public.caye_relationships(workspace_id, id) on delete restrict
);

create index if not exists caye_work_opportunities_actionable_idx
  on public.caye_work_opportunities (workspace_id, relationship_id, materially_updated_at desc)
  where status = 'observed';

comment on table public.caye_work_opportunities is
  'Evidence-backed potentially useful work Caye may perform. An opportunity is explicitly not authorization, a job, execution, or a result.';
comment on column public.caye_work_opportunities.inference is
  'Caye''s inference from evidence. It must never be presented as an observed fact.';

create table if not exists public.caye_work_opportunity_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  opportunity_id uuid not null,
  source_type text not null,
  source_id text not null,
  observed_fact text not null,
  observed_at timestamptz not null,
  provenance_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (opportunity_id, source_type, source_id),
  foreign key (workspace_id, opportunity_id)
    references public.caye_work_opportunities(workspace_id, id) on delete restrict
);

create index if not exists caye_work_opportunity_evidence_opportunity_idx
  on public.caye_work_opportunity_evidence (workspace_id, opportunity_id, observed_at desc);

comment on table public.caye_work_opportunity_evidence is
  'Immutable observed facts and provenance for a work opportunity. The fact is distinct from the opportunity inference.';

-- Evidence corrections must be new, explicit records. No ordinary path may
-- silently rewrite the observed fact or its provenance after persistence.
create or replace function public.caye_prevent_work_opportunity_evidence_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'work opportunity evidence is immutable; record a correction as new evidence';
end;
$$;

create trigger caye_work_opportunity_evidence_immutable
  before update on public.caye_work_opportunity_evidence
  for each row execute function public.caye_prevent_work_opportunity_evidence_update();

alter table public.caye_relationships enable row level security;
alter table public.caye_work_opportunities enable row level security;
alter table public.caye_work_opportunity_evidence enable row level security;

-- Resolve a canonical relationship exactly once. Phase 2 may record a real
-- human interaction as engaged; no Phase 2 path writes client/inactive.
create or replace function public.caye_resolve_relationship(
  p_workspace_id uuid,
  p_contact_id uuid,
  p_originating_capability text,
  p_interaction_at timestamptz,
  p_mark_engaged boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  relationship_id uuid;
  previous_state text;
begin
  perform 1 from public.contacts
    where id = p_contact_id and customer_id = p_workspace_id;
  if not found then
    raise exception 'contact % is not in workspace %', p_contact_id, p_workspace_id;
  end if;

  insert into public.caye_relationships (
    workspace_id, contact_id, originating_capability,
    meaningful_interaction_started_at, last_meaningful_interaction_at
  ) values (
    p_workspace_id, p_contact_id, p_originating_capability,
    p_interaction_at, p_interaction_at
  ) on conflict (workspace_id, contact_id) do nothing
  returning id into relationship_id;

  if relationship_id is not null then
    insert into public.workspace_events (
      workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin
    ) values (
      p_workspace_id, p_interaction_at, 'relationship_created', 'caye',
      'caye_relationships', relationship_id::text,
      jsonb_build_object('state', 'prospect', 'counterparty_type', 'contact'), 'app'
    );
  else
    select id, relationship_state into relationship_id, previous_state
      from public.caye_relationships
      where workspace_id = p_workspace_id and contact_id = p_contact_id
      for update;
    update public.caye_relationships
      set last_meaningful_interaction_at = p_interaction_at,
          updated_at = now()
      where id = relationship_id
        and (last_meaningful_interaction_at is null or last_meaningful_interaction_at < p_interaction_at);
  end if;

  if p_mark_engaged then
    select relationship_state into previous_state
      from public.caye_relationships where id = relationship_id for update;
    if previous_state = 'prospect' then
      update public.caye_relationships
        set relationship_state = 'engaged', updated_at = now()
        where id = relationship_id;
      insert into public.workspace_events (
        workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin
      ) values (
        p_workspace_id, p_interaction_at, 'relationship_engaged', 'caye',
        'caye_relationships', relationship_id::text,
        jsonb_build_object('previous_state', 'prospect', 'state', 'engaged'), 'app'
      );
    end if;
  end if;

  return relationship_id;
end;
$$;

-- Record evidence and its inferred opportunity atomically. A retry with the
-- same source reference is a true no-op; a new evidence reference updates the
-- existing stable subject instead of minting a duplicate opportunity.
create or replace function public.caye_record_work_opportunity(
  p_workspace_id uuid,
  p_relationship_id uuid,
  p_originating_capability text,
  p_opportunity_type text,
  p_capability_key text,
  p_subject_key text,
  p_description text,
  p_inference text,
  p_confidence text,
  p_source_type text,
  p_source_id text,
  p_observed_fact text,
  p_observed_at timestamptz,
  p_provenance_metadata jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opportunity_id uuid;
  evidence_id uuid;
  created_opportunity boolean := false;
begin
  if p_confidence not in ('medium', 'high') then
    raise exception 'unsupported opportunity confidence: %', p_confidence;
  end if;
  perform 1 from public.caye_relationships
    where id = p_relationship_id and workspace_id = p_workspace_id;
  if not found then
    raise exception 'relationship % is not in workspace %', p_relationship_id, p_workspace_id;
  end if;

  insert into public.caye_work_opportunities (
    workspace_id, relationship_id, originating_capability, opportunity_type,
    capability_key, subject_key, description, inference, confidence,
    discovered_at, last_evidenced_at, materially_updated_at
  ) values (
    p_workspace_id, p_relationship_id, p_originating_capability, p_opportunity_type,
    p_capability_key, p_subject_key, p_description, p_inference, p_confidence,
    p_observed_at, p_observed_at, p_observed_at
  ) on conflict (workspace_id, relationship_id, originating_capability, opportunity_type, subject_key)
  do nothing returning id into v_opportunity_id;

  if v_opportunity_id is null then
    select id into v_opportunity_id from public.caye_work_opportunities
      where workspace_id = p_workspace_id and relationship_id = p_relationship_id
        and originating_capability = p_originating_capability
        and opportunity_type = p_opportunity_type and subject_key = p_subject_key
      for update;
  else
    created_opportunity := true;
  end if;

  insert into public.caye_work_opportunity_evidence (
    workspace_id, opportunity_id, source_type, source_id, observed_fact,
    observed_at, provenance_metadata
  ) values (
    p_workspace_id, v_opportunity_id, p_source_type, p_source_id, p_observed_fact,
    p_observed_at, coalesce(p_provenance_metadata, '{}'::jsonb)
  ) on conflict (opportunity_id, source_type, source_id) do nothing
  returning id into evidence_id;

  if evidence_id is null then
    return v_opportunity_id;
  end if;

  if created_opportunity then
    insert into public.workspace_events (
      workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin
    ) values (
      p_workspace_id, p_observed_at, 'work_opportunity_created', 'caye',
      'caye_work_opportunities', v_opportunity_id::text,
      jsonb_build_object('capability_key', p_capability_key, 'subject_key', p_subject_key, 'confidence', p_confidence), 'app'
    );
  else
    update public.caye_work_opportunities
      set description = p_description,
          inference = p_inference,
          confidence = case when confidence = 'high' then 'high' else p_confidence end,
          last_evidenced_at = greatest(last_evidenced_at, p_observed_at),
          materially_updated_at = p_observed_at,
          updated_at = now()
      where id = v_opportunity_id;
    insert into public.workspace_events (
      workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin
    ) values (
      p_workspace_id, p_observed_at, 'work_opportunity_materially_updated', 'caye',
      'caye_work_opportunities', v_opportunity_id::text,
      jsonb_build_object('capability_key', p_capability_key, 'subject_key', p_subject_key), 'app'
    );
  end if;

  return v_opportunity_id;
end;
$$;

revoke all on function public.caye_resolve_relationship(uuid, uuid, text, timestamptz, boolean)
  from public, anon, authenticated;
revoke all on function public.caye_record_work_opportunity(uuid, uuid, text, text, text, text, text, text, text, text, text, text, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.caye_resolve_relationship(uuid, uuid, text, timestamptz, boolean)
  to service_role;
grant execute on function public.caye_record_work_opportunity(uuid, uuid, text, text, text, text, text, text, text, text, text, text, timestamptz, jsonb)
  to service_role;
