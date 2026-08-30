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

A later genuine telemetry ingest restores source state, capability evidence, and device status to active through the existing atomic ingestion path. A recovery trigger records `monitoring.perception_source_recovered` even when the recovered telemetry values are unchanged, because unchanged metric values are correctly filtered from the ordinary-change stream.

The recovery event requires a newer observation and a `fresh_until` still in the future at write time. A delayed packet that is already expired can therefore never masquerade as canonical recovery evidence.

## Epistemic boundary

Sensor silence is not a direct observation. The stale event is explicitly labeled:

- `epistemic_kind: inference`
- `inference_kind: freshness_expired`
- `severity: warning`
- `anomaly: true`

Recovery is also represented as an explicit inference over source state, grounded in a new real observation:

- `epistemic_kind: inference`
- `inference_kind: fresh_observation_reactivated_source`
- `severity: info`
- `anomaly: false`

This does not fabricate a sensor reading, physical failure, or physical recovery cause. The inference concerns source freshness/availability only.

## Authority boundary

Freshness monitoring does **not**:

- send an owner/customer message;
- execute a device command;
- create or expand operational authority;
- auto-enrol hardware;
- infer the physical cause of sensor silence.

It changes monitored state and emits evidence only. Stale/recovery events deliberately keep `is_failure=false`; otherwise the canonical event stream would make them reportable regardless of interruption policy and silently bypass the anti-spam/attention boundary that has not been wired yet.

## Failure and concurrency behavior

- Missing cron configuration fails closed with HTTP 503.
- Missing/wrong cron authorization fails before the sweep.
- Database errors return HTTP 500 so the scheduler can retry.
- `FOR UPDATE SKIP LOCKED` prevents concurrent sweeps from double-processing the same source.
- The source must still be active and expired when updated, so a concurrent fresh observation wins on recovery rather than being silently overwritten.
- Re-running a sweep does not emit repeated stale events because already-stale sources are no longer eligible.
- Recovery is emitted only on a stale -> active transition backed by a newer still-fresh observation.

## Tests

Coverage includes the service RPC runner contract, cron authorization and retry behavior, migration-level active -> stale transitions, capability downgrades, stale/recovery epistemic labeling, recovery freshness guards, service-role isolation, and lack of notification/action authority.
