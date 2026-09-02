-- Business Entity / Domain Source Kernel v1
--
-- WHAT THIS IS
-- A durable identity and federation layer for operational entities. It answers
-- exactly one question: "what business thing is this, and who is authoritative
-- for its state?" It is deliberately NOT another domain database.
--
-- WHAT THIS IS NOT
-- There is no `state jsonb`, no `external_record jsonb`, no mirror of any
-- external row. ODS Construction's real operational state (projects, payroll,
-- purchase orders, estimates) lives in Bedrock/TropiTrack and stays there.
-- Caye holds a stable identity for those things so facts, events, artifacts,
-- attention, recommendations and investigations have something durable to hang
-- off. Copying Bedrock rows in here would make Caye a badly synchronised second
-- copy of a database it does not own, which is the failure mode this table
-- exists to prevent.
--
--   Caye remembers. Models think. Domain systems own the operational state
--   they are authoritative for.
--
-- RELATIONSHIP TO workspace_events
-- Unchanged. `workspace_events` already carries arbitrary payload, and the
-- domain event bridge records the resolved identity at
-- payload -> 'entity' ->> 'caye_entity_id'. No event schema change is needed
-- or made here. See lib/domain/workspace-events.ts.
--
-- ACCESS
-- Service-role only, like the rest of the Caye back-office tables. RLS is on
-- with zero policies: that is the intended deny-by-default state, not an
-- unfinished job. Every reader goes through createServiceClient.

-- ---------------------------------------------------------------------------
-- 1. Entities
-- ---------------------------------------------------------------------------

create table if not exists public.business_entities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,

  -- Domain-neutral classification. 'construction'/'project', 'sales'/'lead'.
  -- Deliberately free text: the kernel must not grow a construction-specific
  -- enum, and a new domain must not require a migration.
  domain text not null check (char_length(btrim(domain)) between 1 and 80),
  entity_type text not null check (char_length(btrim(entity_type)) between 1 and 80),

  -- Presentation only, and therefore nullable. Identity must be creatable from
  -- identity alone; a resolver that only holds an external id must not be
  -- forced to invent a name to obtain a canonical Caye id.
  display_name text check (display_name is null or char_length(btrim(display_name)) between 1 and 200),

  authority text not null check (authority in (
    'caye_authoritative',
    'external_authoritative',
    'evidence_only',
    'derived_read_model'
  )),

  -- The external identity triplet. All three or none of the three.
  source_system text check (source_system is null or char_length(btrim(source_system)) between 1 and 80),
  source_entity_type text check (source_entity_type is null or char_length(btrim(source_entity_type)) between 1 and 120),
  source_entity_id text check (source_entity_id is null or char_length(btrim(source_entity_id)) between 1 and 200),

  -- Explicit deterministic key for Caye-native entities. This exists so nobody
  -- is tempted to invent a fake source_system to get idempotent registration
  -- of something Caye itself owns.
  native_key text check (native_key is null or char_length(btrim(native_key)) between 1 and 200),

  status text not null default 'active' check (status in ('active', 'archived')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Lets related tables use a workspace-safe composite reference, so a
  -- cross-workspace edge is impossible rather than merely discouraged.
  unique (workspace_id, id),

  constraint business_entities_source_identity_complete check (
    (source_system is null and source_entity_type is null and source_entity_id is null)
    or (source_system is not null and source_entity_type is not null and source_entity_id is not null)
  ),
  -- An externally authoritative entity without a source identity is a claim
  -- that some other system owns this, with no way to ask that system.
  constraint business_entities_external_requires_source check (
    authority <> 'external_authoritative' or source_system is not null
  ),
  -- A Caye-authoritative entity carrying a source identity is two different
  -- authority claims in one row.
  constraint business_entities_native_rejects_source check (
    authority <> 'caye_authoritative' or source_system is null
  ),
  constraint business_entities_native_key_requires_caye_authority check (
    native_key is null or authority = 'caye_authoritative'
  ),
  constraint business_entities_archive_pairing check (
    (status = 'archived') = (archived_at is not null)
  )
);

-- The concurrency arbiter for external resolution. Workspace-scoped, so the
-- same Bedrock project id in two workspaces is two independent Caye entities,
-- and source_system-scoped, so 'bedrock'/'project'/'abc' cannot collide with
-- 'another-system'/'project'/'abc'. Intentionally NOT filtered on status:
-- an archived entity keeps its identity forever and re-registration resolves
-- back to it rather than minting a duplicate.
create unique index if not exists business_entities_source_identity_key
  on public.business_entities (workspace_id, source_system, source_entity_type, source_entity_id)
  where source_system is not null;

create unique index if not exists business_entities_native_key_key
  on public.business_entities (workspace_id, domain, entity_type, native_key)
  where native_key is not null;

create index if not exists business_entities_workspace_lookup_idx
  on public.business_entities (workspace_id, domain, entity_type, status, created_at desc);

create index if not exists business_entities_authority_idx
  on public.business_entities (workspace_id, authority)
  where authority <> 'caye_authoritative';

comment on table public.business_entities is
  'Durable workspace-scoped identity for operational entities, Caye-native or externally authoritative. Identity and authority binding only — never a mirror of external operational state.';
comment on column public.business_entities.authority is
  'Who owns the truth: caye_authoritative | external_authoritative | evidence_only | derived_read_model.';
comment on column public.business_entities.native_key is
  'Optional deterministic key for Caye-native entities. Never use external source identity for this.';

-- ---------------------------------------------------------------------------
-- 2. Relations
-- ---------------------------------------------------------------------------
--
-- Durable relationships between canonical Caye identities. Domain-neutral by
-- construction: relation_type is free text, because a construction-specific
-- enum here would make the kernel a construction kernel.

create table if not exists public.business_entity_relations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  subject_entity_id uuid not null,
  object_entity_id uuid not null,
  relation_type text not null check (char_length(btrim(relation_type)) between 1 and 80),

  status text not null default 'active' check (status in ('active', 'archived')),

  -- Why Caye believes this. Reuses the existing artifact/provenance vocabulary
  -- rather than opening a second evidence universe: a relation asserted
  -- directly by an authoritative adapter needs no artifact, an inferred one
  -- should point at the evidence that produced it.
  asserted_by text not null check (asserted_by in (
    'domain_adapter', 'caye_inference', 'operator', 'founder', 'system'
  )),
  source_system text check (source_system is null or char_length(btrim(source_system)) between 1 and 80),
  source_artifact_id uuid references public.business_artifacts(id) on delete set null,
  provenance jsonb not null default '{}'::jsonb,
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),

  first_asserted_at timestamptz not null default now(),
  last_asserted_at timestamptz not null default now(),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Workspace-safe composite references. A relation in workspace A physically
  -- cannot point at an entity in workspace B, including through direct SQL.
  foreign key (workspace_id, subject_entity_id)
    references public.business_entities (workspace_id, id) on delete cascade,
  foreign key (workspace_id, object_entity_id)
    references public.business_entities (workspace_id, id) on delete cascade,

  constraint business_entity_relations_no_self_edge check (subject_entity_id <> object_entity_id),
  constraint business_entity_relations_provenance_is_object check (jsonb_typeof(provenance) = 'object'),
  constraint business_entity_relations_adapter_requires_source check (
    asserted_by <> 'domain_adapter' or source_system is not null
  ),
  constraint business_entity_relations_archive_pairing check (
    (status = 'archived') = (archived_at is not null)
  )
);

-- One active edge per (subject, relation_type, object). Polling the same
-- authoritative relationship twenty times produces one edge, and the database
-- is what enforces that, not application memory. Archived edges are exempt so
-- a relationship that was retired and later re-established keeps its history.
create unique index if not exists business_entity_relations_active_edge_key
  on public.business_entity_relations (workspace_id, subject_entity_id, relation_type, object_entity_id)
  where status = 'active';

create index if not exists business_entity_relations_subject_idx
  on public.business_entity_relations (workspace_id, subject_entity_id, relation_type)
  where status = 'active';

create index if not exists business_entity_relations_object_idx
  on public.business_entity_relations (workspace_id, object_entity_id, relation_type)
  where status = 'active';

comment on table public.business_entity_relations is
  'Durable domain-neutral relationships between canonical business entity identities. Workspace integrity is enforced by composite foreign keys, not by application filters.';

-- ---------------------------------------------------------------------------
-- 3. Domain source connections
-- ---------------------------------------------------------------------------
--
-- workspace -> source system -> external tenant. This is the ONLY place a
-- tenant/company identifier belongs. Entity identity is deliberately free of
-- it, so rotating credentials or re-pointing a connection cannot change what
-- a business entity IS.
--
-- No secrets live here. `credential_ref` is a name that server-side code
-- resolves against its own secret store; the check constraints below make
-- pasting an actual key into this table fail rather than succeed quietly.

create table if not exists public.domain_source_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  source_system text not null check (char_length(btrim(source_system)) between 1 and 80),
  external_tenant_id text not null check (char_length(btrim(external_tenant_id)) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'paused', 'revoked')),
  credential_ref text check (credential_ref is null or credential_ref ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,119}$'),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, source_system),
  constraint domain_source_connections_config_is_object check (jsonb_typeof(config) = 'object'),
  constraint domain_source_connections_config_holds_no_secrets check (
    not (config ?| array[
      'serviceRoleKey', 'service_role_key', 'apiKey', 'api_key', 'password',
      'secret', 'token', 'accessToken', 'access_token', 'refreshToken',
      'refresh_token', 'privateKey', 'private_key', 'clientSecret', 'client_secret'
    ])
  )
);

create index if not exists domain_source_connections_source_idx
  on public.domain_source_connections (source_system, status);

comment on table public.domain_source_connections is
  'Binds a Caye workspace to an external tenant in a domain source system. Holds credential references, never credentials. Entity identity never depends on this row.';
comment on column public.domain_source_connections.credential_ref is
  'Name of a secret in the server-side secret store. Never a secret value.';

-- ---------------------------------------------------------------------------
-- 4. Resolution
-- ---------------------------------------------------------------------------
--
-- Identity resolution is a single function so that concurrency is arbitrated
-- by the unique indexes above rather than by a select-then-insert race. Two
-- workers resolving the same Bedrock project at the same instant get the same
-- uuid; one of them takes the ON CONFLICT branch.
--
-- Case handling: system/type names are folded to lower case so 'Bedrock' and
-- 'bedrock' are one source system. `source_entity_id` is trimmed but otherwise
-- preserved verbatim, because external ids are frequently case-sensitive and
-- normalising them would silently merge two distinct external records.

create or replace function public.resolve_business_entity(
  p_workspace_id uuid,
  p_domain text,
  p_entity_type text,
  p_authority text,
  p_source_system text default null,
  p_source_entity_type text default null,
  p_source_entity_id text default null,
  p_display_name text default null,
  p_native_key text default null
)
returns public.business_entities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_domain text;
  v_entity_type text;
  v_authority text;
  v_source_system text;
  v_source_entity_type text;
  v_source_entity_id text;
  v_native_key text;
  v_display_name text;
  v_present integer;
  v_row public.business_entities%rowtype;
begin
  if p_workspace_id is null then
    raise exception 'business entity resolution requires a workspace';
  end if;

  v_domain := lower(nullif(btrim(coalesce(p_domain, '')), ''));
  v_entity_type := lower(nullif(btrim(coalesce(p_entity_type, '')), ''));
  v_authority := lower(nullif(btrim(coalesce(p_authority, '')), ''));
  v_source_system := lower(nullif(btrim(coalesce(p_source_system, '')), ''));
  v_source_entity_type := lower(nullif(btrim(coalesce(p_source_entity_type, '')), ''));
  v_source_entity_id := nullif(btrim(coalesce(p_source_entity_id, '')), '');
  v_native_key := nullif(btrim(coalesce(p_native_key, '')), '');
  v_display_name := nullif(btrim(coalesce(p_display_name, '')), '');

  if v_domain is null then raise exception 'business entity resolution requires a domain'; end if;
  if v_entity_type is null then raise exception 'business entity resolution requires an entity type'; end if;
  if v_authority not in ('caye_authoritative','external_authoritative','evidence_only','derived_read_model') then
    raise exception 'unsupported business entity authority: %', coalesce(v_authority, '(null)');
  end if;

  -- Fully specified or entirely absent. A half-specified external identity is
  -- the shape that produces duplicate identities under retry, so it is
  -- rejected here with a readable error as well as by the table constraint.
  v_present :=
    (v_source_system is not null)::integer +
    (v_source_entity_type is not null)::integer +
    (v_source_entity_id is not null)::integer;
  if v_present not in (0, 3) then
    raise exception 'partial external source identity: source_system/source_entity_type/source_entity_id must be all present or all absent';
  end if;

  if v_authority = 'external_authoritative' and v_present = 0 then
    raise exception 'external_authoritative business entity requires a complete external source identity';
  end if;
  if v_authority = 'caye_authoritative' and v_present = 3 then
    raise exception 'caye_authoritative business entity must not carry external source identity';
  end if;
  if v_native_key is not null and v_authority <> 'caye_authoritative' then
    raise exception 'native_key is only valid for caye_authoritative business entities';
  end if;

  if v_present = 3 then
    insert into public.business_entities (
      workspace_id, domain, entity_type, display_name, authority,
      source_system, source_entity_type, source_entity_id
    ) values (
      p_workspace_id, v_domain, v_entity_type, v_display_name, v_authority,
      v_source_system, v_source_entity_type, v_source_entity_id
    )
    on conflict (workspace_id, source_system, source_entity_type, source_entity_id)
      where source_system is not null
    do update set
      -- Presentation may be refreshed. Identity and authority may not, and a
      -- caller that omits a display name must never blank an existing one.
      display_name = coalesce(excluded.display_name, public.business_entities.display_name),
      updated_at = case
        when excluded.display_name is not null
         and excluded.display_name is distinct from public.business_entities.display_name
        then now()
        else public.business_entities.updated_at
      end
    returning * into v_row;

  elsif v_native_key is not null then
    insert into public.business_entities (
      workspace_id, domain, entity_type, display_name, authority, native_key
    ) values (
      p_workspace_id, v_domain, v_entity_type, v_display_name, v_authority, v_native_key
    )
    on conflict (workspace_id, domain, entity_type, native_key)
      where native_key is not null
    do update set
      display_name = coalesce(excluded.display_name, public.business_entities.display_name),
      updated_at = case
        when excluded.display_name is not null
         and excluded.display_name is distinct from public.business_entities.display_name
        then now()
        else public.business_entities.updated_at
      end
    returning * into v_row;

  else
    -- No deterministic key was offered, so this is an explicit request for a
    -- new identity rather than a resolution.
    insert into public.business_entities (
      workspace_id, domain, entity_type, display_name, authority
    ) values (
      p_workspace_id, v_domain, v_entity_type, v_display_name, v_authority
    )
    returning * into v_row;
  end if;

  -- Authority and classification are part of what an entity IS. A caller that
  -- disagrees with the stored row has a bug, and silently accepting it would
  -- let a read-only mirror be relabelled as Caye-owned truth.
  if v_row.authority is distinct from v_authority then
    raise exception 'business entity % already exists with authority %, refusing to re-register as %',
      v_row.id, v_row.authority, v_authority;
  end if;
  if v_row.domain is distinct from v_domain or v_row.entity_type is distinct from v_entity_type then
    raise exception 'business entity % already exists as %/%, refusing to re-register as %/%',
      v_row.id, v_row.domain, v_row.entity_type, v_domain, v_entity_type;
  end if;

  return v_row;
end;
$$;

revoke all on function public.resolve_business_entity(uuid, text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_business_entity(uuid, text, text, text, text, text, text, text, text)
  to service_role;

comment on function public.resolve_business_entity(uuid, text, text, text, text, text, text, text, text) is
  'Idempotently resolves or registers a canonical business entity identity. Concurrency is arbitrated by the unique indexes, not by select-then-insert.';

-- ---------------------------------------------------------------------------
-- 5. Relation upsert
-- ---------------------------------------------------------------------------

create or replace function public.upsert_business_entity_relation(
  p_workspace_id uuid,
  p_subject_entity_id uuid,
  p_object_entity_id uuid,
  p_relation_type text,
  p_asserted_by text,
  p_source_system text default null,
  p_source_artifact_id uuid default null,
  p_provenance jsonb default '{}'::jsonb,
  p_confidence double precision default null,
  p_asserted_at timestamptz default now()
)
returns public.business_entity_relations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_relation_type text;
  v_asserted_by text;
  v_source_system text;
  v_provenance jsonb;
  v_asserted_at timestamptz;
  v_row public.business_entity_relations%rowtype;
begin
  if p_workspace_id is null then
    raise exception 'business entity relation requires a workspace';
  end if;

  v_relation_type := lower(nullif(btrim(coalesce(p_relation_type, '')), ''));
  v_asserted_by := lower(nullif(btrim(coalesce(p_asserted_by, '')), ''));
  v_source_system := lower(nullif(btrim(coalesce(p_source_system, '')), ''));
  v_provenance := coalesce(p_provenance, '{}'::jsonb);
  v_asserted_at := coalesce(p_asserted_at, now());

  if v_relation_type is null then
    raise exception 'business entity relation requires a relation type';
  end if;
  if v_asserted_by not in ('domain_adapter','caye_inference','operator','founder','system') then
    raise exception 'unsupported business entity relation assertion source: %', coalesce(v_asserted_by, '(null)');
  end if;
  if jsonb_typeof(v_provenance) <> 'object' then
    raise exception 'business entity relation provenance must be an object';
  end if;

  -- The composite foreign keys below would reject these anyway; checking here
  -- turns a constraint-name error into something a caller can act on.
  if not exists (
    select 1 from public.business_entities
    where id = p_subject_entity_id and workspace_id = p_workspace_id
  ) then
    raise exception 'business entity relation subject % is not in workspace %', p_subject_entity_id, p_workspace_id;
  end if;
  if not exists (
    select 1 from public.business_entities
    where id = p_object_entity_id and workspace_id = p_workspace_id
  ) then
    raise exception 'business entity relation object % is not in workspace %', p_object_entity_id, p_workspace_id;
  end if;

  insert into public.business_entity_relations (
    workspace_id, subject_entity_id, object_entity_id, relation_type,
    asserted_by, source_system, source_artifact_id, provenance, confidence,
    first_asserted_at, last_asserted_at
  ) values (
    p_workspace_id, p_subject_entity_id, p_object_entity_id, v_relation_type,
    v_asserted_by, v_source_system, p_source_artifact_id, v_provenance, p_confidence,
    v_asserted_at, v_asserted_at
  )
  on conflict (workspace_id, subject_entity_id, relation_type, object_entity_id)
    where status = 'active'
  do update set
    -- Re-observing a relationship refreshes when it was last seen and may add
    -- provenance, but never rewrites the original assertion out of history.
    last_asserted_at = greatest(public.business_entity_relations.last_asserted_at, excluded.last_asserted_at),
    provenance = case
      when public.business_entity_relations.provenance = '{}'::jsonb then excluded.provenance
      else public.business_entity_relations.provenance
    end,
    source_artifact_id = coalesce(public.business_entity_relations.source_artifact_id, excluded.source_artifact_id),
    confidence = coalesce(excluded.confidence, public.business_entity_relations.confidence),
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.upsert_business_entity_relation(
  uuid, uuid, uuid, text, text, text, uuid, jsonb, double precision, timestamptz
) from public, anon, authenticated;
grant execute on function public.upsert_business_entity_relation(
  uuid, uuid, uuid, text, text, text, uuid, jsonb, double precision, timestamptz
) to service_role;

comment on function public.upsert_business_entity_relation(
  uuid, uuid, uuid, text, text, text, uuid, jsonb, double precision, timestamptz
) is
  'Idempotently asserts one active durable relation between two canonical entities in the same workspace.';

-- ---------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------
-- Deny-by-default. No anon/authenticated policies is the intended state; a
-- future client-side reader should fail loudly and get an explicit, reviewed
-- policy rather than inherit one by accident.

alter table public.business_entities enable row level security;
alter table public.business_entity_relations enable row level security;
alter table public.domain_source_connections enable row level security;

revoke all on public.business_entities from anon, authenticated;
revoke all on public.business_entity_relations from anon, authenticated;
revoke all on public.domain_source_connections from anon, authenticated;
