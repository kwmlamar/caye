-- Phase 1 semantic isolation foundation.
--
-- This migration deliberately does not change learning/retrieval/opportunity
-- eligibility. It only establishes persisted semantic provenance, a monotonic
-- derivation invariant, and deterministic historical classification.

create table if not exists public.semantic_provenance (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  record_table text not null,
  record_id text not null,
  semantic_scope text not null default 'legacy_unclassified',
  origin_surface text not null,
  origin_actor_type text not null,
  origin_ref text not null,
  scope_version integer not null default 1 check (scope_version > 0),
  parent_provenance_id uuid references public.semantic_provenance(id) on delete restrict,
  ingestion_route text,
  originating_capability text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint semantic_provenance_record_uidx unique (record_table, record_id),
  constraint semantic_provenance_scope_check check (semantic_scope in (
    'customer_business',
    'customer_operator',
    'founder_admin',
    'platform_test',
    'engineering_task',
    'personal_direct_task',
    'system_internal',
    'legacy_unclassified'
  ))
);

create index if not exists semantic_provenance_workspace_scope_idx
  on public.semantic_provenance(workspace_id, semantic_scope, created_at desc);
create index if not exists semantic_provenance_parent_idx
  on public.semantic_provenance(parent_provenance_id)
  where parent_provenance_id is not null;

comment on table public.semantic_provenance is
  'Canonical semantic-scope sidecar for persisted Caye records. workspace_id identifies tenant; semantic_scope identifies meaning/context.';
comment on column public.semantic_provenance.origin_actor_type is
  'Actor identity is provenance only and is intentionally independent from semantic_scope.';

create or replace function public.caye_is_valid_semantic_scope(p_scope text)
returns boolean
language sql
immutable
as $$
  select p_scope in (
    'customer_business',
    'customer_operator',
    'founder_admin',
    'platform_test',
    'engineering_task',
    'personal_direct_task',
    'system_internal',
    'legacy_unclassified'
  );
$$;

create or replace function public.caye_can_derive_semantic_scope(
  p_parent_scope text,
  p_requested_child_scope text
)
returns boolean
language sql
immutable
as $$
  select
    public.caye_is_valid_semantic_scope(p_parent_scope)
    and public.caye_is_valid_semantic_scope(p_requested_child_scope)
    and (
      p_parent_scope = p_requested_child_scope
      or (
        p_parent_scope = 'customer_business'
        and p_requested_child_scope = 'system_internal'
      )
    );
$$;

comment on function public.caye_can_derive_semantic_scope(text, text) is
  'Canonical monotonic semantic derivation rule. Trusted scope promotion, if ever added, must use a separate explicit path.';

create or replace function public.caye_semantic_record_workspace(
  p_record_table text,
  p_record_id text
)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_workspace_id uuid;
begin
  case p_record_table
    when 'unified_messages' then
      select ca.user_id into v_workspace_id
      from public.unified_messages um
      join public.unified_conversations uc on uc.id = um.conversation_id
      join public.connected_accounts ca on ca.id = uc.connected_account_id
      where um.id::text = p_record_id;
    when 'caye_operator_messages' then
      select workspace_id into v_workspace_id from public.caye_operator_messages where id::text = p_record_id;
    when 'workspace_events' then
      select workspace_id into v_workspace_id from public.workspace_events where id::text = p_record_id;
    when 'business_artifacts' then
      select workspace_id into v_workspace_id from public.business_artifacts where id::text = p_record_id;
    when 'business_artifact_observations' then
      select workspace_id into v_workspace_id from public.business_artifact_observations where id::text = p_record_id;
    when 'business_learning_observations' then
      select workspace_id into v_workspace_id from public.business_learning_observations where id::text = p_record_id;
    when 'business_facts' then
      select workspace_id into v_workspace_id from public.business_facts where id::text = p_record_id;
    when 'business_fact_candidates' then
      select workspace_id into v_workspace_id from public.business_fact_candidates where id::text = p_record_id;
    when 'caye_work_opportunities' then
      select workspace_id into v_workspace_id from public.caye_work_opportunities where id::text = p_record_id;
    when 'caye_work_opportunity_evidence' then
      select workspace_id into v_workspace_id from public.caye_work_opportunity_evidence where id::text = p_record_id;
    when 'engineering_artifacts' then
      select workspace_id into v_workspace_id from public.engineering_artifacts where id::text = p_record_id;
    else
      raise exception 'semantic provenance does not support record table %', p_record_table;
  end case;
  return v_workspace_id;
end;
$$;

create or replace function public.caye_enforce_semantic_provenance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent public.semantic_provenance%rowtype;
  v_record_workspace uuid;
begin
  if not public.caye_is_valid_semantic_scope(new.semantic_scope) then
    raise exception 'invalid semantic scope: %', new.semantic_scope;
  end if;

  v_record_workspace := public.caye_semantic_record_workspace(new.record_table, new.record_id);
  if v_record_workspace is null then
    raise exception 'semantic provenance source record %.% does not exist or has no workspace', new.record_table, new.record_id;
  end if;
  if v_record_workspace <> new.workspace_id then
    raise exception 'semantic provenance workspace mismatch for %.%: record %, provenance %',
      new.record_table, new.record_id, v_record_workspace, new.workspace_id;
  end if;

  if new.parent_provenance_id is not null then
    select * into v_parent
    from public.semantic_provenance
    where id = new.parent_provenance_id;

    if not found then
      raise exception 'semantic provenance parent % does not exist', new.parent_provenance_id;
    end if;
    if v_parent.workspace_id <> new.workspace_id then
      raise exception 'semantic scope derivation cannot cross workspaces';
    end if;
    if not public.caye_can_derive_semantic_scope(v_parent.semantic_scope, new.semantic_scope) then
      raise exception 'semantic scope cannot widen from % to %', v_parent.semantic_scope, new.semantic_scope;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_caye_enforce_semantic_provenance on public.semantic_provenance;
create trigger trg_caye_enforce_semantic_provenance
before insert or update of workspace_id, record_table, record_id, semantic_scope, parent_provenance_id
on public.semantic_provenance
for each row execute function public.caye_enforce_semantic_provenance();

-- Existing learning observations carried a nullable, unconstrained scope hint.
-- Harden it to the canonical vocabulary. Unknown legacy values fail closed.
update public.business_learning_observations
set semantic_scope = 'legacy_unclassified'
where semantic_scope is null
   or not public.caye_is_valid_semantic_scope(semantic_scope);

alter table public.business_learning_observations
  alter column semantic_scope set default 'legacy_unclassified',
  alter column semantic_scope set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'business_learning_observations_semantic_scope_check'
      and conrelid = 'public.business_learning_observations'::regclass
  ) then
    alter table public.business_learning_observations
      add constraint business_learning_observations_semantic_scope_check
      check (public.caye_is_valid_semantic_scope(semantic_scope));
  end if;
end;
$$;

-- Deterministic historical classifier. It uses source mechanics, never message
-- text or an LLM. Ambiguous/direct history remains legacy_unclassified.
create or replace view public.semantic_provenance_backfill_candidates as
select
  'unified_messages'::text as record_table,
  um.id::text as record_id,
  ca.user_id as workspace_id,
  case
    when coalesce(um.is_internal, false) then 'system_internal'
    when lower(uc.channel_type::text) in ('email','gmail','whatsapp') then 'customer_business'
    else 'legacy_unclassified'
  end::text as semantic_scope,
  lower(uc.channel_type::text) as origin_surface,
  um.sender_type::text as origin_actor_type,
  'unified_messages:' || um.id::text as origin_ref,
  1::integer as scope_version,
  null::text as parent_record_table,
  null::text as parent_record_id,
  'unified_messages'::text as ingestion_route,
  null::text as originating_capability
from public.unified_messages um
join public.unified_conversations uc on uc.id = um.conversation_id
join public.connected_accounts ca on ca.id = uc.connected_account_id

union all
select
  'caye_operator_messages',
  om.id::text,
  om.workspace_id,
  case
    when lower(coalesce(om.origin, '')) ~ '(founder|job[_ -]?search|admin[_ -]?shell)' then 'founder_admin'
    when lower(coalesce(om.origin, '')) ~ '(platform[_ -]?test|test[_ -]?harness|multimodal[_ -]?test)' then 'platform_test'
    when lower(coalesce(om.origin, '')) ~ '(engineering|fea)' then 'engineering_task'
    when lower(coalesce(om.origin, '')) ~ '(system|internal|cron|worker)' then 'system_internal'
    else 'customer_operator'
  end,
  coalesce(nullif(lower(om.origin), ''), 'operator'),
  'customer_operator',
  'caye_operator_messages:' || om.id::text,
  1,
  null,
  null,
  'caye_operator_messages',
  case when lower(coalesce(om.origin, '')) ~ '(founder|job[_ -]?search)' then 'founder_job_search' else null end
from public.caye_operator_messages om

union all
select
  'workspace_events',
  we.id::text,
  we.workspace_id,
  case
    when lower(coalesce(we.actor_kind, '')) ~ '(engineering|fea)' or lower(coalesce(we.origin, '')) ~ '(engineering|fea)' then 'engineering_task'
    when lower(coalesce(we.actor_kind, '')) ~ '(founder|admin)' or lower(coalesce(we.origin, '')) ~ '(founder|job[_ -]?search|admin)' then 'founder_admin'
    when lower(coalesce(we.origin, '')) ~ '(platform[_ -]?test|test[_ -]?harness|multimodal[_ -]?test)' then 'platform_test'
    when lower(coalesce(we.actor_kind, '')) in ('system','caye') or lower(coalesce(we.origin, '')) ~ '(trigger|cron|worker|system|internal)' then 'system_internal'
    else 'legacy_unclassified'
  end,
  coalesce(nullif(lower(we.origin), ''), 'workspace_event'),
  we.actor_kind,
  'workspace_events:' || we.id::text,
  1,
  null,
  null,
  'workspace_events',
  null
from public.workspace_events we

union all
select
  'business_artifacts',
  ba.id::text,
  ba.workspace_id,
  case
    when lower(coalesce(ba.origin, '')) ~ '(engineering|fea)' then 'engineering_task'
    when lower(coalesce(ba.origin, '')) ~ '(founder|job[_ -]?search|admin)' then 'founder_admin'
    when lower(coalesce(ba.origin, '')) ~ '(platform[_ -]?test|test[_ -]?harness|multimodal[_ -]?test)' then 'platform_test'
    when lower(coalesce(ba.origin, '')) ~ '(system|internal|cron|worker)' then 'system_internal'
    when ba.operator_message_id is not null then 'customer_operator'
    when lower(coalesce(ba.source_channel, '')) in ('email','gmail','whatsapp') and lower(coalesce(ba.origin, 'external')) = 'external' then 'customer_business'
    else 'legacy_unclassified'
  end,
  coalesce(nullif(lower(ba.source_channel), ''), nullif(lower(ba.origin), ''), 'artifact'),
  case when ba.operator_message_id is not null then 'customer_operator' else 'external_sender' end,
  'business_artifacts:' || ba.id::text,
  1,
  case when ba.unified_message_id is not null then 'unified_messages' when ba.operator_message_id is not null then 'caye_operator_messages' else null end,
  coalesce(ba.unified_message_id::text, ba.operator_message_id::text),
  'business_artifacts',
  null
from public.business_artifacts ba

union all
select
  'business_artifact_observations',
  o.id::text,
  o.workspace_id,
  coalesce(p.semantic_scope, 'legacy_unclassified'),
  'artifact_observation',
  'system_internal',
  'business_artifact_observations:' || o.id::text,
  1,
  'business_artifacts',
  o.artifact_id::text,
  'business_artifact_observations',
  o.derived_by
from public.business_artifact_observations o
left join public.semantic_provenance p
  on p.record_table = 'business_artifacts' and p.record_id = o.artifact_id::text

union all
select
  'business_learning_observations',
  o.id::text,
  o.workspace_id,
  coalesce(p.semantic_scope,
    case
      when o.source_kind = 'unified_message' and lower(coalesce(o.source_channel, '')) in ('email','gmail','whatsapp') then 'customer_business'
      when o.source_kind = 'operator_message' then 'customer_operator'
      else 'legacy_unclassified'
    end),
  coalesce(nullif(lower(o.source_channel), ''), o.source_kind),
  coalesce(o.source_metadata->>'sender_type', o.source_metadata->>'operator_role', 'unknown'),
  o.source_kind || ':' || o.source_id,
  1,
  case when o.unified_message_id is not null then 'unified_messages' when o.operator_message_id is not null then 'caye_operator_messages' else null end,
  coalesce(o.unified_message_id::text, o.operator_message_id::text),
  'business_learning_observations',
  null
from public.business_learning_observations o
left join public.semantic_provenance p
  on (o.unified_message_id is not null and p.record_table = 'unified_messages' and p.record_id = o.unified_message_id::text)
  or (o.operator_message_id is not null and p.record_table = 'caye_operator_messages' and p.record_id = o.operator_message_id::text)

union all
select
  'business_fact_candidates',
  c.id::text,
  c.workspace_id,
  coalesce(p.semantic_scope, 'legacy_unclassified'),
  'business_learning',
  'system_internal',
  'business_fact_candidates:' || c.id::text,
  1,
  case when c.observation_id is not null then 'business_learning_observations' else null end,
  c.observation_id::text,
  'business_fact_candidates',
  null
from public.business_fact_candidates c
left join public.semantic_provenance p
  on c.observation_id is not null
 and p.record_table = 'business_learning_observations'
 and p.record_id = c.observation_id::text

union all
select
  'business_facts',
  f.id::text,
  f.workspace_id,
  case
    when lower(coalesce(f.source, '')) in ('email','gmail','whatsapp','customer-communication','onboarding','configured','business-profile') then 'customer_business'
    when lower(coalesce(f.source, '')) ~ '(engineering|fea)' then 'engineering_task'
    when lower(coalesce(f.source, '')) ~ '(founder[_ -]?admin|job[_ -]?search)' then 'founder_admin'
    when lower(coalesce(f.source, '')) ~ '(platform[_ -]?test|test[_ -]?harness)' then 'platform_test'
    when lower(coalesce(f.source, '')) ~ '(system[_ -]?internal|internal)' then 'system_internal'
    else 'legacy_unclassified'
  end,
  coalesce(nullif(lower(f.source), ''), 'business_fact'),
  coalesce(nullif(lower(f.authority_kind), ''), 'unknown'),
  'business_facts:' || f.id::text,
  1,
  null,
  null,
  'business_facts',
  null
from public.business_facts f

union all
select
  'caye_work_opportunities',
  o.id::text,
  o.workspace_id,
  case
    when lower(coalesce(o.originating_capability, '')) ~ '(engineering|fea)' then 'engineering_task'
    when lower(coalesce(o.originating_capability, '')) ~ '(founder|job[_ -]?search|admin)' then 'founder_admin'
    when lower(coalesce(o.originating_capability, '')) ~ '(platform[_ -]?test|test[_ -]?harness)' then 'platform_test'
    when lower(coalesce(o.originating_capability, '')) ~ '(system|internal)' then 'system_internal'
    else 'legacy_unclassified'
  end,
  'opportunity',
  'system_internal',
  'caye_work_opportunities:' || o.id::text,
  1,
  null,
  null,
  'caye_work_opportunities',
  o.originating_capability
from public.caye_work_opportunities o

union all
select
  'caye_work_opportunity_evidence',
  e.id::text,
  e.workspace_id,
  coalesce(src.semantic_scope, 'legacy_unclassified'),
  coalesce(nullif(lower(e.source_type), ''), 'opportunity_evidence'),
  'unknown',
  coalesce(nullif(e.source_type, ''), 'source') || ':' || coalesce(nullif(e.source_id, ''), e.id::text),
  1,
  case
    when lower(coalesce(e.source_type, '')) in ('unified_message','unified_messages') then 'unified_messages'
    when lower(coalesce(e.source_type, '')) in ('operator_message','caye_operator_messages') then 'caye_operator_messages'
    when lower(coalesce(e.source_type, '')) in ('business_artifact','business_artifacts') then 'business_artifacts'
    when lower(coalesce(e.source_type, '')) in ('business_learning_observation','business_learning_observations') then 'business_learning_observations'
    else null
  end,
  case when coalesce(e.source_id, '') <> '' then e.source_id else null end,
  'caye_work_opportunity_evidence',
  null
from public.caye_work_opportunity_evidence e
left join public.semantic_provenance src
  on src.record_id = e.source_id
 and src.record_table = case
    when lower(coalesce(e.source_type, '')) in ('unified_message','unified_messages') then 'unified_messages'
    when lower(coalesce(e.source_type, '')) in ('operator_message','caye_operator_messages') then 'caye_operator_messages'
    when lower(coalesce(e.source_type, '')) in ('business_artifact','business_artifacts') then 'business_artifacts'
    when lower(coalesce(e.source_type, '')) in ('business_learning_observation','business_learning_observations') then 'business_learning_observations'
    else '__unsupported__'
  end

union all
select
  'engineering_artifacts',
  e.id::text,
  e.workspace_id,
  'engineering_task',
  'engineering',
  'engineering_capability',
  'engineering_artifacts:' || e.id::text,
  1,
  case when e.parent_artifact_id is not null then 'engineering_artifacts' else null end,
  e.parent_artifact_id::text,
  'engineering_artifacts',
  'engineering_copilot'
from public.engineering_artifacts e;

comment on view public.semantic_provenance_backfill_candidates is
  'Deterministic Phase 1 semantic classification. No content inspection or LLM inference; ambiguous sources fail closed.';

create or replace function public.backfill_semantic_provenance(p_dry_run boolean default true)
returns table (
  record_table text,
  semantic_scope text,
  candidate_count bigint,
  would_insert_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  i integer;
begin
  if not p_dry_run then
    -- Several passes allow derived rows to attach after their parent sidecar is
    -- inserted by an earlier pass. Unique(record_table, record_id) makes reruns
    -- idempotent.
    for i in 1..6 loop
      insert into public.semantic_provenance (
        workspace_id, record_table, record_id, semantic_scope,
        origin_surface, origin_actor_type, origin_ref, scope_version,
        parent_provenance_id, ingestion_route, originating_capability
      )
      select
        c.workspace_id,
        c.record_table,
        c.record_id,
        case when c.parent_record_table is not null then p.semantic_scope else c.semantic_scope end,
        c.origin_surface,
        c.origin_actor_type,
        c.origin_ref,
        c.scope_version,
        p.id,
        c.ingestion_route,
        c.originating_capability
      from public.semantic_provenance_backfill_candidates c
      left join public.semantic_provenance p
        on p.record_table = c.parent_record_table
       and p.record_id = c.parent_record_id
      where not exists (
        select 1 from public.semantic_provenance existing
        where existing.record_table = c.record_table
          and existing.record_id = c.record_id
      )
        and (c.parent_record_table is null or p.id is not null)
      on conflict on constraint semantic_provenance_record_uidx do nothing;
    end loop;

    update public.business_learning_observations o
    set semantic_scope = p.semantic_scope
    from public.semantic_provenance p
    where p.record_table = 'business_learning_observations'
      and p.record_id = o.id::text
      and o.semantic_scope is distinct from p.semantic_scope;
  end if;

  return query
  select
    c.record_table,
    c.semantic_scope,
    count(*)::bigint,
    count(*) filter (where existing.id is null)::bigint
  from public.semantic_provenance_backfill_candidates c
  left join public.semantic_provenance existing
    on existing.record_table = c.record_table
   and existing.record_id = c.record_id
  group by c.record_table, c.semantic_scope
  order by c.record_table, c.semantic_scope;
end;
$$;

comment on function public.backfill_semantic_provenance(boolean) is
  'Idempotent deterministic historical semantic-provenance backfill. dry_run=true performs no writes.';

-- Existing history is classified once at migration time. Rerunning the helper
-- later is safe and is the supported observability/dry-run surface.
select * from public.backfill_semantic_provenance(false);
