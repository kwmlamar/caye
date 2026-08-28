-- CAY-25 durable current-state projection.
-- Recent observation history may be windowed for UI/context size, but "current"
-- must never depend on that window. This view selects the newest observation
-- for every semantic (subject, key) pair across the full durable history.

create or replace view public.property_current_observations as
select
  id,
  workspace_id,
  property_id,
  structure_id,
  system_id,
  asset_id,
  observation_key,
  numeric_value,
  text_value,
  unit,
  provenance_status,
  confidence,
  source_artifact_id,
  source_message_id,
  notes,
  observed_at,
  created_at
from (
  select distinct on (workspace_id, property_id, subject_key, observation_key)
    id,
    workspace_id,
    property_id,
    structure_id,
    system_id,
    asset_id,
    observation_key,
    numeric_value,
    text_value,
    unit,
    provenance_status,
    confidence,
    source_artifact_id,
    source_message_id,
    notes,
    observed_at,
    created_at
  from (
    select
      o.*,
      case
        when o.asset_id is not null then 'asset:' || o.asset_id::text
        when o.system_id is not null then 'system:' || o.system_id::text
        when o.structure_id is not null then 'structure:' || o.structure_id::text
        else 'property'
      end as subject_key
    from public.property_observations o
  ) scoped
  order by workspace_id, property_id, subject_key, observation_key, observed_at desc, created_at desc, id desc
) current_rows;

-- The view is a service-role read model only. Do not create an authenticated
-- shortcut around the property tables' intentionally policy-less RLS boundary.
revoke all on table public.property_current_observations from public, anon, authenticated;
grant select on table public.property_current_observations to service_role;
