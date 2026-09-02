-- Narrow corrective migration for PR #426 adversarial findings F-5/F-6/F-7.
-- Not applied to production. Integration migrations are still review-only.

-- F-5: artifact provenance must be workspace-safe, not merely artifact-id-safe.
alter table public.business_artifacts
  add constraint business_artifacts_workspace_id_id_key unique (workspace_id, id);

alter table public.business_entity_relations
  drop constraint if exists business_entity_relations_source_artifact_id_fkey;
alter table public.business_entity_relations
  add constraint business_entity_relations_source_artifact_workspace_fkey
  foreign key (workspace_id, source_artifact_id)
  references public.business_artifacts(workspace_id, id);

-- F-6: bridge state belongs to a real workspace and observation identity, when
-- resolved, must be a canonical entity in that same workspace.
alter table public.domain_sync_cursors
  add constraint domain_sync_cursors_workspace_fkey
  foreign key (workspace_id) references public.customers(id) on delete cascade;

alter table public.domain_entity_observation_state
  add constraint domain_entity_observation_state_workspace_fkey
  foreign key (workspace_id) references public.customers(id) on delete cascade;

alter table public.domain_entity_observation_state
  alter column caye_entity_id type uuid using nullif(caye_entity_id, '')::uuid;

alter table public.domain_entity_observation_state
  add constraint domain_entity_observation_state_entity_workspace_fkey
  foreign key (workspace_id, caye_entity_id)
  references public.business_entities(workspace_id, id);

-- F-7: DB contract now matches the server-side DOMAIN_SECRET_<REF> resolver.
-- The resolver accepts only lower-case alphanumeric/underscore refs, 1..64.
alter table public.domain_source_connections
  drop constraint if exists domain_source_connections_credential_ref_check;
alter table public.domain_source_connections
  add constraint domain_source_connections_credential_ref_check
  check (credential_ref is null or credential_ref ~ '^[a-z0-9_]{1,64}$');
