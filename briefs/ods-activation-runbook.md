# ODS Activation Runbook

## Status

Operator runbook. **Every step here must be run by Lamar, not by an agent** — each one
either applies a production migration, writes a production row, or handles a credential.
No coding agent on this repo has that authority.

Nothing in this runbook has been executed.

## What is already true

The Bedrock/TropiTrack integration is built, reviewed and merged. It is not switched on.

| Component | State |
|---|---|
| `lib/domain-adapters/bedrock/` — read-only adapter | merged on `main`, no consumer until this branch |
| `lib/domain/` — connections, secrets, entities, resolver | merged |
| `lib/domain-events/` — normalize, bridge, sink, checkpoints | merged |
| `lib/domain-attention.ts` — domain events → owner attention | **this branch** |
| `find_job` / `get_job` / `get_job_labor` / `get_payroll_status` tools | **this branch** |
| The four kernel migrations | **not applied to production** |
| `domain_source_connections` row for ODS | **does not exist** |
| A cron invoking the sync | **does not exist** |

Verified against the live Caye database on 2026-09-03: **zero tables matching `domain%`
exist.** The repository and production have drifted — do not assume otherwise anywhere in
this process. `lib/domain-adapters/bedrock/README.md` documents a second instance of the
same drift (RLS is enabled in a repo migration and still disabled in production on
`estimates`, `receipts`, `materials` and others).

## Identifiers

| Thing | Value |
|---|---|
| Caye workspace | `ODS Construction Co.`, created 2026-08-31, status `trial` |
| TropiTrack (Bedrock) company | `ODS Construction`, company id `4ee41a41-7790-4e26-8d3c-e8ce66ab38a3` |
| TropiTrack Supabase project | `rrqpwtggiirexptnhyqy` (region us-east-2) |
| Caye Supabase project | `fetsfbdltlxjsomiqvrw` (region us-east-1) |

Look up the Caye workspace UUID yourself at run time rather than pasting one from a
document — the provisioning CLI fails closed on a wrong workspace, but a wrong *company*
id would bind ODS's Caye workspace to someone else's ledger and the CLI cannot detect that.

## Step 1 — apply the four migrations, in this order

They are an ordered unit. The fourth is a correctness migration from the final review pass,
not optional cleanup, and PostgREST cannot verify index presence afterwards — applying all
four together is what guarantees the runtime-critical indexes exist.

```
supabase/migrations/20260901190000_business_entity_kernel.sql
supabase/migrations/20260901_domain_event_projection_bridge.sql
supabase/migrations/20260902000000_domain_change_source_snapshots.sql
supabase/migrations/20260902043000_domain_integration_review_fixes.sql
```

Afterwards confirm these exist: `business_entities`, `business_entity_relations`,
`domain_source_connections`, `domain_sync_cursors`, `domain_entity_observation_state`,
`domain_change_source_snapshots`, and the function `ingest_external_domain_event`.

## Step 2 — place the TropiTrack credential

The server resolves `credential_ref` as `DOMAIN_SECRET_<UPPERCASE_REF>`. The ref must match
`^[a-z0-9_]{1,64}$` — that constraint exists so a database row cannot name an arbitrary env
var such as `SUPABASE_SERVICE_ROLE_KEY`.

Set `DOMAIN_SECRET_BEDROCK_ODS` in the Caye server environment to TropiTrack's service-role
key. **Never** put the value in a Caye table, an event, a snapshot, config JSON, a log, a
CLI argument, or shell history. The deprecated `BEDROCK_CONNECTIONS_JSON` pattern was
deliberately removed — do not reintroduce it.

## Step 3 — provisioning dry run

Dry run is the default and performs no writes.

```bash
node scripts/provision-bedrock-domain.mjs \
  --workspace-id <CAYE_WORKSPACE_UUID> \
  --bedrock-company-id 4ee41a41-7790-4e26-8d3c-e8ce66ab38a3 \
  --bedrock-supabase-url <TROPITRACK_SUPABASE_URL> \
  --credential-ref bedrock_ods
```

Expect: workspace found · credential reference present · server secret resolvable · required
tables and RPC present · TropiTrack company reachable through a read-only `companies` lookup
· `writes_performed: false` · `sync_invoked: false`.

Read the output rather than skimming it. This is the only gate before a production binding.

## Step 4 — apply the binding

Re-run the identical command with `--apply`. The only permitted write is one insert into
`domain_source_connections`. Re-running against an exact active row is a no-op; any
different existing row fails closed and needs review rather than a repair flag.

## Step 5 — read-only smoke test

Before any sync. Confirm the adapter answers for the real workspace and — more importantly —
that it refuses everything else:

- `adapter.health(workspaceId)` succeeds.
- `adapter.listProjects(workspaceId)` returns ODS's real projects.
- The same calls against **a different workspace id** fail closed rather than returning ODS
  data. `lib/domain-adapters/bedrock/tenant-isolation.smoke.test.ts` is the existing shape
  for this.

## Step 6 — the WhatsApp read surface

At this point the tools on this branch can answer from the real ledger. Test over WhatsApp,
as Wallace, from an allowlisted phone:

- *"what's the contract value on Christiansen?"* → $25,945
- *"how many hours have we put into Capricorn?"* → from `get_job_labor`
- *"blue sky"* → should return **candidates**, not a guess (two active Blue Sky scopes exist)

The third is the one to watch. A confident wrong answer here silently corrupts job costing,
which is the one thing this system exists to make trustworthy.

## Step 7 — sync and attention, last and separately

Only after 1–6 are all verified. These two are what make the system *act* rather than
answer, so they change the risk profile.

1. A cron invoking `runBedrockPurchaseOrderSync({ workspaceId })`. Nothing calls it today.
   Start with one workspace and a small `maxBatches`.
2. A cron invoking `projectDomainEventsToAttention({ workspaceId })` (`lib/domain-attention.ts`)
   so accepted changes reach the briefing. Without this the events land and stop.

Both are read-only against TropiTrack. Neither can write to the source system: the provider
exposes no mutation and the adapter has no write methods.

**Expect the first attention run after a sync to be quiet.** Bootstrap events are skipped by
design — connecting a ledger with sixteen months of history must not deliver sixteen months
of news. Only changes occurring *after* the first sync raise attention. If the first run is
loud, stop and investigate; something is misclassifying first sight as a transition.

## Order that must not be rearranged

Migrations → credential → dry run → binding → read smoke test → read tools over WhatsApp →
sync → attention.

Each step's failure mode is contained only if the ones before it are verified. Provisioning
before the migrations fails closed and is harmless; a sync before the tenant-isolation smoke
test is not.

## What still does not exist after this runbook

Naming them so nobody assumes otherwise:

- **Change sources beyond `purchase_order`.** `normalize.ts` already has logic for project,
  estimate, receipt, pay_period and payroll_entry, but only `BedrockPurchaseOrderChangeSource`
  exists to feed it. Those entities are readable on demand and will not raise attention on
  change. `time_entry` is deliberately suppressed — individual time edits are not AI-visible.
- **Any write path into TropiTrack.** The adapter is read-only by construction. Omar's daily
  crew log and Jay's receipt capture (Milestones 2 and 3 of
  `ods-whatsapp-operating-surface.md`) need a propose/commit/verify write boundary that does
  not exist yet.
- **`workspace_event_cursors` is still unused** by any application code.
- **The `caye_outbound_queue` kind enum has no construction kind.** Adding one requires both
  the TypeScript `OutboundKind` union and a migration extending the CHECK constraint — they
  are asserted in lockstep by an existing test, and three past migrations exist because
  someone once changed only one side and broke escalation delivery entirely.
