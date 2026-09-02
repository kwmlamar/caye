# Domain source connection provisioning

This is an operator/server runbook only. Provisioning does **not** activate production sync.

## Authority boundary

Caye is the persistent intelligence/operating layer. Bedrock/TropiTrack remains authoritative for construction operational state. The production integration is read-only against Bedrock. Do not copy Bedrock projects, workers, payroll, estimates, purchase orders, receipts, or other operational rows into Caye.

## Required Caye migrations

Apply the merged PR #426 migrations in repository/manifest order before provisioning:

1. `20260901190000_business_entity_kernel.sql`
   - `business_entities`
   - `business_entity_relations`
   - `domain_source_connections`
   - entity resolution/supporting indexes and access controls
2. `20260901_domain_event_projection_bridge.sql`
   - `domain_sync_cursors`
   - `domain_entity_observation_state`
   - `workspace_events_domain_idempotency_unique_idx`
   - `ingest_external_domain_event(...)`
3. `20260902000000_domain_change_source_snapshots.sql`
   - `domain_change_source_snapshots`
4. `20260902043000_domain_integration_review_fixes.sql`
   - workspace-safe foreign keys
   - UUID observation-state entity binding
   - final `credential_ref` constraint matching the server resolver
   - `workspace_events_domain_observed_at_idx`

The fourth migration is required. It is a correctness migration from the final PR #426 review pass, not optional cleanup.

## Provisioning contract

For one workspace, exactly one connection row is expected:

`Caye workspace -> domain_source_connections -> source_system='bedrock' -> external_tenant_id=<Bedrock company UUID>`

`config.supabase_url` is the non-secret Bedrock Supabase URL. `credential_ref` is a lowercase reference matching `^[a-z0-9_]{1,64}$`; the server resolves it as `DOMAIN_SECRET_<UPPERCASE_REF>`. The secret value must never be stored in Caye tables, events, snapshots, entities, config JSON, logs, shell history, or CLI arguments.

The provisioning CLI refuses to repoint an existing Bedrock connection. An existing row is considered idempotently provisioned only when company id, active status, credential reference, and Bedrock URL all match exactly. Paused, revoked, or mismatched rows require operator review rather than automatic repair.

## Dry run

Set the Caye server environment normally, and materialise the Bedrock credential through its dedicated environment reference. Then run:

```bash
node scripts/provision-bedrock-domain.mjs \
  --workspace-id <CAYE_WORKSPACE_UUID> \
  --bedrock-company-id <BEDROCK_COMPANY_UUID> \
  --bedrock-supabase-url <BEDROCK_SUPABASE_URL> \
  --credential-ref <LOWERCASE_CREDENTIAL_REF>
```

Dry-run is the default. It reports:

- workspace found
- requested Bedrock company binding
- existing connection status and whether it is an exact match
- credential reference present
- server secret resolvable
- required Caye tables and RPC surface present
- Bedrock company reachable through a read-only `companies` lookup
- `writes_performed: false`
- `sync_invoked: false`

The CLI never prints the resolved secret value. PostgREST exposes the required tables and RPC surface but not index metadata; index presence is therefore enforced by applying the four reviewed migrations as an ordered unit before this gate. The runtime-critical supporting indexes are named above for migration verification.

## Future apply step

Only after the migrations and dry-run have been reviewed, re-run the same command with `--apply`. The only permitted write is an insert into Caye `domain_source_connections` when no Bedrock row exists. Re-running against an exact active row is a no-op. Any different existing row fails closed.

Do **not** create cron, invoke `runBedrockPurchaseOrderSync`, mutate Bedrock, or enable autonomous production behavior as part of provisioning. A separately reviewed read-only smoke test and an explicit later activation decision are required before any production synchronization is invoked.
