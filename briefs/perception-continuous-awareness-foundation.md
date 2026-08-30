# Perception & Continuous Awareness foundation

## Mission

Give Caye a shared, evidence-backed path from authorized operational signals to durable awareness:

`observe -> normalize -> correlate -> detect meaningful change -> determine importance -> update state -> act if separately authorized OR surface attention`

This change owns perception, observations/events, monitoring, change detection and interruption policy. It does not redesign memory, research, engineering simulation, or the general execution/authority model.

## Architecture audit

Main already contains substantial proactive behavior rather than a blank slate:

- `workspace_events` is the canonical workspace history. It is trigger-backed for messages, bookings, escalations, holds and channel health, with per-operator delivery cursors.
- Email is perceived through both Gmail polling and Zoho polling/webhook paths; inbound messages ultimately become canonical message events.
- WhatsApp/Instagram/Messenger webhooks ingest inbound channel activity.
- Bookings generate canonical creation/status events and drive reminder/outbound workers.
- Owner attention has durable attention records, notification gating, operator-awareness state fingerprints and follow-up workers.
- Growth Intelligence already separates source state, observations, diagnoses and recommendations.
- Job Search has a dedicated email poll plus sourcing/preparation workers.
- Property Intelligence has provider-authenticated physical telemetry ingestion with registered-device authority, immutable raw events, normalized measurements and current telemetry.
- Research has a dedicated worker/runtime and remains outside this change except as an audited proactive source.
- Founder surfaces include the capability gateway and `live-events`, both already designed around narrow authenticated reads.

The repo therefore does **not** need another event bus. `workspace_events` remains the canonical statement that something happened. Domain tables remain authoritative source evidence. Perception adds only current monitoring state and capability evidence.

## Unified perception semantics

A perception event written into `workspace_events` carries an envelope in `payload`:

- `epistemic_kind`: `observation` for directly normalized source facts. Future inferred events must say `inference`; they must never masquerade as observations.
- `change_kind`: `initial`, `ordinary_change`, or future `anomaly`. Unchanged polls remain in their source history but do not spam the canonical change stream.
- `anomaly`: explicit boolean. Ordinary change is not automatically an anomaly.
- `confidence`: source/normalization confidence, not model bravado.
- `fresh_until`: when the observation should stop being treated as current.
- `importance` / `severity`: classification input for downstream attention policy, not authority to execute.
- `source`: stable source identity and provider provenance.
- source table/id: durable provenance back to the authoritative record.

`perception_source_state` is a current-state projection, not history. Its unique key includes workspace + source identity + subject identity. It tracks fingerprint, freshness, confidence, failure/retry state and the most recent canonical observation event.

`perception_capability_evidence` is a truthful readiness/evidence projection for Direction. A capability is `active` only after a real source produced evidence. Merely having code or a connector does not count.

## First real end-to-end source: property telemetry

The existing `/api/webhooks/property-telemetry` ingress remains the boundary. It already:

1. requires a configured secret and constant-time authentication;
2. normalizes The Things Network payloads;
3. refuses to auto-enrol unknown hardware;
4. calls one atomic database RPC;
5. returns a 5xx on persistence failure so the provider can retry;
6. treats duplicate provider event IDs idempotently.

The RPC is extended so one transaction now:

1. resolves an explicitly registered device and therefore its workspace;
2. retains the immutable raw provider event;
3. writes normalized metrics;
4. fingerprints the normalized state and correlates it with prior source state;
5. writes `observation.property_telemetry` to `workspace_events` only for initial/changed state;
6. updates source freshness/current-state;
7. updates capability evidence;
8. advances the device heartbeat.

No observation sends a message, changes a device, edits a booking, or grants any new tool permission.

## Isolation and idempotency

- Device -> workspace authority is resolved server-side from `property_sensor_devices`; the webhook cannot choose a workspace.
- Perception state/evidence tables have RLS enabled and no client policies. They are service-role only; model/founder reads go through the authenticated capability gateway.
- Source-state uniqueness is workspace-scoped.
- Raw property telemetry is already unique by provider event identity and returns `duplicate` on retry.
- Canonical perception events also have a uniqueness guard on workspace/type/source row.
- The pure dedupe identity includes workspace + source kind + source identity + source event identity, preventing cross-workspace correlation even when providers recycle IDs.

## Interruption budget

`lib/perception/policy.ts` supplies the shared policy primitive, but this PR intentionally does not wire it into every existing notifier yet.

Rules:

- stale observations do not interrupt;
- low-confidence observations do not interrupt;
- routine ordinary changes do not interrupt;
- warning/anomaly interruptions obey a window budget;
- critical alerts may pierce the count budget but equivalent repeats still obey cooldown;
- interruption is a notification decision only. It is never execution authorization.

This gives future attention/notifier integrations one policy instead of each cron inventing its own enthusiasm level.

## Failure behavior

The first source inherits the existing atomic telemetry transaction. A partial ingest cannot commit. Database errors return HTTP 500, allowing provider retry; duplicate provider events safely return success without creating duplicate normalized rows or perception events. Unknown devices return 404 and are not enrolled. Invalid source payloads return 400 and do not mutate state.

`retryDelaySeconds` provides capped exponential backoff for future poll-based source adapters. Per-source state has `consecutive_failures`, `last_failure_*` and `retry_after` fields so failures can be represented rather than silently converted into empty observations.

## Autonomous today

Genuinely autonomous after this foundation is deployed and an authorized property sensor is active:

- receive authenticated property telemetry without a founder prompt;
- normalize supported sensor readings;
- retain source provenance;
- deduplicate provider retries;
- correlate normalized readings with prior state;
- recognize initial vs unchanged vs ordinary changed state;
- maintain freshness/current monitoring state;
- emit meaningful changed observations into the canonical workspace event stream;
- expose evidence/freshness through the read-only `perception.status` founder capability.

Existing independent systems also autonomously poll/receive email and social channels, maintain booking/reminder flows, run attention/growth/job-search/research workers, and surface events, but they are **not** claimed as migrated to this perception contract by this PR.

## Not autonomous yet

- Generic anomaly detection across telemetry. This source deliberately reports `anomaly: false` until property/system-specific thresholds or learned baselines exist.
- Cross-source correlation across email, bookings, growth, job search, research and property state.
- A universal scheduler/source adapter contract.
- Automatic interruption routing from perception policy into owner attention.
- Automatic actions in response to observations. Action authority remains where it already lives.
- Sensor auto-enrolment or authority expansion of any kind.
- Inference generation. Future inferred events must be explicitly labeled and evidence-linked.

Those are roadmap items, not claims hidden behind a green badge.

## Tests

`lib/perception/policy.test.ts` covers:

- workspace-separated source identity;
- deterministic/idempotent source identity;
- initial/unchanged/ordinary-change/anomaly distinction;
- capped retry backoff;
- stale and low-confidence suppression;
- routine suppression;
- interruption-budget exhaustion;
- critical-alert cooldown behavior.

Database constraints and the existing atomic property telemetry RPC provide the integration-level idempotency/failure boundary; the webhook continues to fail closed on missing secret, invalid payload, unknown device and persistence errors.
