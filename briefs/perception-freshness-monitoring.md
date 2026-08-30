# Perception freshness monitoring

This follow-up makes source freshness an actively monitored state rather than a timestamp that is only interpreted when `perception.status` is queried.

## Runtime loop

Every 15 minutes, the existing Vercel cron substrate calls `/api/caye/perception-freshness`. The route requires `CRON_SECRET` and invokes the service-role-only `refresh_perception_freshness` RPC.

The RPC atomically finds perception sources that are still marked `active` but whose `fresh_until` has passed, locks them with `FOR UPDATE SKIP LOCKED`, and transitions them to `stale` exactly once per active -> stale cycle.

For each stale transition it:

- marks the durable `perception_source_state` row stale;
- downgrades matching live perception capability evidence to `limited` and `autonomous_now=false`;
- marks a linked active property sensor stale when the source is property telemetry;
- records a canonical `monitoring.perception_source_stale` event in `workspace_events`.

A later genuine telemetry ingest already restores source state, capability evidence, and device status to active through the existing atomic ingestion path.

## Epistemic boundary

Sensor silence is not a direct observation. The stale event is explicitly labeled:

- `epistemic_kind: inference`
- `inference_kind: freshness_expired`
- `severity: warning`
- `anomaly: true`

The inference is deterministic and grounded in the source's previously recorded `fresh_until`; it does not fabricate a sensor reading or claim a physical failure.

## Authority boundary

Freshness monitoring does **not**:

- send an owner/customer message;
- execute a device command;
- create or expand operational authority;
- auto-enrol hardware;
- infer the physical cause of sensor silence.

It changes monitored state and emits evidence only. Any later interruption or action must pass its own existing policy/authority boundary.

## Failure and concurrency behavior

- Missing cron configuration fails closed with HTTP 503.
- Missing/wrong cron authorization fails before the sweep.
- Database errors return HTTP 500 so the scheduler can retry.
- `FOR UPDATE SKIP LOCKED` prevents concurrent sweeps from double-processing the same source.
- The source must still be active and expired when updated, so a concurrent fresh observation wins on recovery rather than being silently overwritten.
- Re-running a sweep does not emit repeated stale events because already-stale sources are no longer eligible.

## Tests

Coverage includes the service RPC runner contract, cron authorization and retry behavior, and migration-level invariants for active -> stale transitions, capability downgrades, epistemic labeling, service-role isolation, and lack of action authority.
