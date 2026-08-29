# Caye capability layer

This directory is the model-agnostic boundary between reasoning layers and Caye's durable systems.

V0.1 is intentionally read-first. Capability manifests are public semantic contracts; execution handlers remain server-only. Invocation scope is trusted server context, never widened by model-supplied args. Results distinguish observation, inference, staging, execution, and failure so a reasoning layer cannot equate planning with completion.

Initial reads:

- `goals.list`: operator direction when no workspace is active, otherwise exactly one workspace's non-superseded goals.
- `attention.list`: unresolved founder attention for exactly one active workspace; raw internal escalation context is reduced through the existing founder-safe briefing layer before it crosses this boundary.
- `engineering.artifacts.list`: trusted engineering artifact metadata for exactly one active workspace.
- `job_search.summary` / `job_search.queue.list`: founder-only job-search operator state. Never workspace-scoped.
- `property.list` (CAY-28): founder-visible property discovery. Never workspace-scoped — lists across every workspace the founder can see, mirroring the cross-workspace read authority `property.snapshot` already has. Returns only `{ id, name, locationLabel }` per property: no `status`, no `workspace_id`, no metadata. `id` is the deliberate, stable public selector — the same value `property.snapshot` accepts as `propertyId`. This exists so a fresh external reasoning session has a bounded way to find a property without already knowing an internal DB id: `property.list -> pick id -> property.snapshot`.
- `property.snapshot` (CAY-28): a founder-visible physical property snapshot — identity, structures, systems, assets, current observations, linked engineering projects, and open issues — for exactly one `propertyId` (obtained from `property.list`). Resolves its owning workspace canonically from the property id itself via `resolveFounderPropertyWorkspaceId`, so a caller-supplied `workspaceId` is never used as authority for this capability. This is the one capability that accepts an id-scoped selector (`propertyId`) instead of a bare workspace scope; see `PROPERTY_ID_SCOPED_CAPABILITIES` in `gateway.ts` — adding another id-scoped capability means extending that allowlist deliberately, not widening `args` generically.

  **Output boundary**: only explicitly allowlisted, human-meaningful fields cross into `data`. Raw durable-storage blobs (`structures[].metadata`, `systems[].metadata`, `assets[].specifications`) are never included — there is no existing founder-safe allowlisted type for arbitrary property/system/asset `metadata`/`specifications`, so v1 omits them entirely rather than inventing new semantics or leaking raw JSONB. Nested structure/system/asset/observation/project ids are also not exposed in `data`; systems/assets/observations instead carry a resolved human-readable `structureName`/`systemName`/`subjectLabel`. Internal record ids remain available in `evidence` (`{ kind: 'record', id }`), per the existing evidence contract — `property.id` is the one deliberate exception, since it is the public selector returned by `property.list` and already used by the founder `/api/founder/property-snapshots/[id]` REST route.

Do not add raw SQL/storage capabilities or bypass existing authority/execution gates here.
