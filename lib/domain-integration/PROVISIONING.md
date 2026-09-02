# Domain source connection provisioning

This is an operator/server runbook only. PR #426 does **not** activate production sync.

1. Choose a `credential_ref` matching `^[a-z0-9_]{1,64}$` and provision the corresponding server secret as `DOMAIN_SECRET_<REF>`, where `<REF>` is the resolver's uppercase form of that reference. Never store the secret value in Caye tables, events, snapshots, entities, or config JSON.
2. Create one `domain_source_connections` row for the Caye workspace and `source_system = 'bedrock'`. Put only the non-secret Bedrock Supabase URL in `config.supabase_url`; put the reference name in `credential_ref`.
3. Set `external_tenant_id` to the authoritative Bedrock company id. That row is the workspace ↔ external-company binding. Do not infer company scope from entity ids or caller input.
4. Expect fail-closed behavior. Missing/revoked/paused connections, invalid refs, missing secrets, malformed config, health/company mismatches, or cross-company rows must stop the sync rather than widening access.

Before any production activation, perform the separately reviewed read-only Bedrock smoke test. Do not create cron, invoke production sync, mutate Bedrock, or apply the integration migrations as part of this runbook review pass.
