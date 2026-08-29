# Caye capability layer

This directory is the model-agnostic boundary between reasoning layers and Caye's durable systems.

V0.1 is intentionally read-first. Capability manifests are public semantic contracts; execution handlers remain server-only. Invocation scope is trusted server context, never widened by model-supplied args. Results distinguish observation, inference, staging, execution, and failure so a reasoning layer cannot equate planning with completion.

Initial reads:

- `goals.list`: operator direction when no workspace is active, otherwise exactly one workspace's non-superseded goals.
- `attention.list`: unresolved founder attention for exactly one active workspace; raw internal escalation context is reduced through the existing founder-safe briefing layer before it crosses this boundary.
- `engineering.artifacts.list`: trusted engineering artifact metadata for exactly one active workspace.
- `job_search.summary` / `job_search.queue.list`: founder-only job-search operator state. Never workspace-scoped.
- `property.snapshot` (CAY-28): a founder-visible physical property snapshot — identity, structures, systems, assets, current observations, linked engineering projects, and open issues — for exactly one `propertyId`. Resolves its owning workspace canonically from the property id itself via `resolveFounderPropertyWorkspaceId`, so a caller-supplied `workspaceId` is never used as authority for this capability. This is the one capability that accepts an id-scoped selector (`propertyId`) instead of a bare workspace scope; see `PROPERTY_ID_SCOPED_CAPABILITIES` in `gateway.ts` — adding another id-scoped capability means extending that allowlist deliberately, not widening `args` generically.

Do not add raw SQL/storage capabilities or bypass existing authority/execution gates here.
