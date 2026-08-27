# Goals and Direction substrate

Caye's durable strategic direction is separate from business memory and separate from the Work/Outcome execution runtime.

## Model

The current substrate stops at:

`Vision -> Domain -> Objective -> Goal -> Initiative`

These records describe what Caye is trying to accomplish and why. They do **not** model Task, Action, or Result execution state. That downstream runtime belongs to CAY-8 and must not be independently recreated here.

## Goals are not memory

Memory answers questions such as "what does this business know or prefer?" Goals carry strategic semantics memory does not: status, priority, prerequisites, activation conditions, progress evidence, hierarchy, and supersession.

Do not store strategic goals as generic business facts merely because both are durable.

## Goals never grant authority

A goal can explain why an action is valuable. It cannot authorize that action.

Goal-aware reasoning remains subordinate to the existing authority, confirmation, policy, risk, evidence, deduplication, and execution gates. Adding or activating a goal must never create a new permission path.

## Scope and tenancy

Goals have either:

- `workspace` scope, tied to exactly one `workspace_id`; or
- `operator` scope, with no workspace, for founder-level cross-business direction.

Per-workspace Caye turns may receive only active, eligible goals from that same workspace. Operator/global goals are intentionally excluded from workspace agent context even when the caller is the founder.

The database also rejects parent and dependency edges that cross scope or workspace boundaries. This is required because normal server-side goal reads use the service role and therefore cannot rely on RLS alone to prevent graph traversal across tenants.

Founder-only Direction APIs may resolve strategic ancestry for dashboard use. The workspace `list_active_goals` agent tool deliberately does not resolve or return ancestor lineage.

## Active eligibility

Existence is not actionability.

Only goals with `status = active` and satisfied prerequisites may enter proactive goal context. Future, blocked, paused, completed, abandoned, or superseded records must not influence active planning.

Activation conditions are advisory. They may indicate that a future goal is eligible to be considered for activation, but they do not automatically change status or grant execution authority.

## Heartbeat integration

The opportunity scan may receive eligible workspace goals as structured prioritization context. This is additive context only.

The heartbeat must not turn goal alignment into a new autonomous execution lane. Existing change detection, attention gating, authority checks, tool risk tiers, confirmations, and execution paths remain authoritative.

## Progress and evidence

Do not fabricate percentage-complete values.

Use explicit status and authoritative metrics when available. Estimated observations must remain labeled as estimates. Metric ingestion from systems such as Stripe is future work; the presence of a target alone is not evidence of progress.

## Supersession

Strategic records are preserved when replaced using `superseded_at` / `superseded_by` rather than silently overwritten or deleted.

The current founder API compensates for an ordinary partial supersession write by deleting a newly-created replacement if retiring the prior goal fails. This is not fully crash-atomic. If strategic writes become concurrent or externally automated, replace this with a transactional database RPC before relying on stronger atomicity guarantees.

## Explicitly deferred

This substrate intentionally does not implement:

- Task / Action / Result runtime semantics (CAY-8)
- autonomous initiative generation
- conversational strategic mutations
- automatic goal activation
- automatic metric ingestion
- resource or budget allocation
- long-horizon replanning

Those capabilities should extend this substrate rather than create parallel strategic state.
