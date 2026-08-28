# Caye capability layer

This directory is the model-agnostic boundary between reasoning layers and Caye's durable systems.

V0.1 is intentionally read-first. Capability manifests are public semantic contracts; execution handlers remain server-only. Invocation scope is trusted server context, never widened by model-supplied args. Results distinguish observation, inference, staging, execution, and failure so a reasoning layer cannot equate planning with completion.

Initial reads:

- `goals.list`: operator direction when no workspace is active, otherwise exactly one workspace's non-superseded goals.
- `attention.list`: unresolved founder attention for exactly one active workspace; raw internal escalation context is reduced through the existing founder-safe briefing layer before it crosses this boundary.

Do not add raw SQL/storage capabilities or bypass existing authority/execution gates here.
