# Autonomous Action + Self-Improvement Adversarial Audit

Date: 2026-08-31 (America/Nassau)
Repository: `kwmlamar/caye`
Baseline: `main` @ `74a3df936c819159d639297d086d41a9039a5255`
Open self-improvement branch reviewed: PR #382 @ `2540a03316f422ddb5368abfea96d27b700402a2`

## Executive decision

**Autonomous recommendation execution: NOT SAFE TO ENABLE.**

**Autonomous self-improvement: NOT SAFE TO ENABLE.**

The sprint contains several strong fail-closed mechanisms: recommendation/version pinning, decision identity checks, execution-time authority re-resolution, code-registered capability lookup, schema validation, bounded wake batches, durable claims, and outcome observation that does not equate execution with recommendation success. Those controls are real and useful.

They are not sufficient yet. The current execution adapter fabricates a permissive autonomy context instead of deriving consequentiality from the actual capability; generic low-risk tools can therefore be misclassified as routine. The pending-operation path is at-least-once across crash/stale-claim recovery rather than exactly-once at the external-effect boundary. Conflicting later recommendations do not deterministically supersede old executable recommendations. `main` is currently unprotected, so failing or incomplete safety CI does not block merge. The open self-improvement PR converts canonical recommendation prose directly into a coding-agent task before deterministic change-risk classification and has no enforced recursion lineage/depth bound across distinct recommendations.

## Scope reviewed

Primary sprint PRs and integration PRs audited:

- #368 — canonical evidence-backed recommendations
- #371 / #374 — recommendation decision lifecycle and execution eligibility
- #372 — recommendation outcome learning/calibration
- #373 — material-intelligence recommendation generation
- #375 — Direction recommendation/decision projection
- #378 — autonomous recommendation outcome observation
- #380 — autonomous recommendation execution bridge
- #381 — canonical capability-schema validation
- #382 — bounded autonomous self-improvement (open; reviewed, not modified)

Audit areas: schema, RLS/grants, SECURITY DEFINER functions, capability mapping, deterministic decision policy, execution claims/retries, cron concurrency, fingerprints/versioning, Direct/owner-attention projection, coding sessions, GitHub merge policy, and outcome-feedback behavior.

## Findings

### BLOCKER 1 — Generic `low` tool metadata can bootstrap consequential autonomous actions

`lib/recommendations/action-plan.ts` treats every registered low-risk founder/back-office tool as recommendation-executable, but only a small hand-written subset receives a consequential `RecommendationActionKind`. Everything else falls back to `routine`.

The same adapter constructs `ActionAutonomyContext` rather than measuring it:

- `reversibility` is always `reversible`;
- `evidenceSufficient` is true whenever the model supplied at least one prose precondition;
- `financialImpactCents` is always `0`;
- `affectedRecords` is always `1`;
- external/destructive classification is based on a short name list;
- the workspace policy is synthesized with `allowedActions: [plan.capabilityKey]` rather than loaded from the current workspace policy.

This defeats the otherwise sound deterministic `decideActionAutonomy` boundary. The model cannot invent a capability name, but it can choose a real capability whose consequentiality was never encoded in this adapter.

Concrete examples currently registered as low-risk include `add_team_member`, which can add a new `owner` to the workspace allowlist after verification, and `switch_workspace`, which changes the founder's sticky active workspace. Neither is classified founder-only by the recommendation adapter. This creates direct paths for recommendation-driven authority escalation or cross-workspace control-state mutation.

**Impact:** unauthorized or incorrectly authorized execution; authority escalation through a recommendation; policy changes silently ignored; stale/current workspace autonomy policy not consulted.

**Required fix:** recommendation autonomy must fail closed for unclassified capabilities. Only code-owned, explicitly classified autonomous capabilities may be routine. Security/identity/authority/workspace/messaging/destructive/configuration capabilities must require founder judgment or be non-executable. The execution-time check must consume current canonical workspace policy rather than constructing one that permits the selected tool.

### BLOCKER 2 — Recommendation execution is not exactly-once across the external-effect boundary

`caye_pending_operations` provides a good single-active-claim CAS under ordinary concurrent workers and a unique logical idempotency key for queue rows. That satisfies simultaneous claim convergence in the happy path.

It does **not** guarantee exactly-once external execution:

1. worker claims operation;
2. registered tool successfully performs an external/write effect;
3. process dies before `markSynced`;
4. after the stale-claim timeout the row is reset to `pending`;
5. another worker replays the tool.

A second race exists when an execution exceeds the fixed stale-claim interval, because the claim has no lease renewal. The generic tool contract does not require the pending-operation idempotency key to be enforced by each side-effect implementation.

The existing duplicate-execution test only covers a second invocation after durable `completed` state is observable. It does not cover crash-after-effect-before-settle.

**Impact:** duplicate messages, duplicate mutations, duplicate external actions, or repeated consequential effects after transient worker failure.

**Required fix:** autonomous recommendation execution must be restricted to capabilities with a code-enforced idempotency/effect-receipt contract tied to the recommendation execution key, or the effect boundary must itself become idempotent. Do not claim exactly-once based only on queue-row uniqueness.

### BLOCKER 3 — Conflicting recommendations are not automatically superseded before execution

The recommendation schema contains `superseded_by` / `superseded_at`, and the executor correctly refuses recommendations explicitly marked superseded or withdrawn.

However, the material-intelligence generation path suppresses only an identical proposal-trigger fingerprint. Contradictory evidence can generate a new recommendation, but no deterministic conflict/supersession step links the new recommendation to an older incompatible recommendation and retires the old one.

Therefore scenario I can occur:

- recommendation A remains accepted/executable;
- negative outcome or contradictory evidence causes recommendation B with the opposite action;
- A is not automatically marked superseded;
- both can remain execution-eligible.

**Impact:** recommendation → action → evidence → opposite recommendation amplification, contradictory actions, oscillation, and stale execution after the system's own evidence changed direction.

**Required fix:** before an opposite/conflicting recommendation can become execution-eligible, a deterministic conflict key/domain must atomically supersede or otherwise make incompatible predecessors non-executable. This must be checked again at execution time.

### BLOCKER 4 — PR #382 turns recommendation prose into coding-agent instructions before deterministic risk classification

PR #382's `deriveCanonicalCodingTask(...)` embeds recommendation title, action prose, and rationale directly into the coding-agent task. `startCodingSessionForRecommendation(...)` checks accepted status, workspace scope, and generic recommendation execution eligibility, then launches the coding session.

The deterministic self-improvement risk classifier runs later in `runGateAndPush`, after the coding model has already received and acted on the prose. Its protected-path/test-only classification constrains whether a produced diff can continue to branch push, but it does not constrain what instructions the coding agent executes inside the sandbox before that point.

This violates the required boundary that natural-language recommendation prose must not become arbitrary execution.

**Impact:** an accepted recommendation can bootstrap arbitrary coding-agent behavior before code-owned classification; model-generated recommendation content becomes executable instruction text.

**Required fix:** do not launch a coding session from arbitrary recommendation prose. Require a code-owned self-improvement recommendation class plus a bounded structured coding intent before sandbox execution; founder-required/protected changes must be rejected before the coding model runs.

**Coordination:** PR #382 is an active agent branch. This audit must not open a competing repair branch against the same files; request changes on #382 instead.

### BLOCKER 5 — Self-improvement recursion is bounded per recommendation, not per lineage

PR #382 adds a unique one-coding-session-per-`recommendation_id` constraint. That prevents the same recommendation from opening multiple coding sessions.

It does not prevent:

`self-improvement recommendation A -> coding/evidence -> recommendation B -> coding/evidence -> recommendation C -> ...`

There is no enforced root session/recommendation lineage, generation depth, recursion budget, or suppression rule for a recommendation produced from self-improvement evidence.

**Impact:** recursive self-improvement sessions and feedback amplification across distinct recommendation IDs.

**Required fix:** persist and enforce a code-owned self-improvement lineage/root plus bounded depth (v1 should normally be depth 1), and suppress autonomous child self-improvement recommendations from creating further sessions.

**Coordination:** fix belongs on PR #382 or a follow-up after it; do not race the active branch.

### HIGH 1 — `main` has no enforced branch protection / required status checks

GitHub reports `main` as `protected: false`, with protection disabled and no required status-check contexts. Repository rulesets are empty.

This is not theoretical. PR #381 merged at 02:45:42Z while its targeted `Autonomous recommendation actions` workflow did not complete successfully until 02:45:50Z. The run passed, but the repository would have allowed the same merge if it later failed.

**Impact:** scenario G is not enforced. Tests/builds can fail after safety-critical code is already merged.

**Required fix:** protect `main` and require the relevant safety/unit/build checks before merge. A workflow file is not a merge gate merely because it exists.

### HIGH 2 — Model-supplied risk/authority classification is persisted without action-derived canonical validation

The recommendation proposer returns `risk`, `reversibility`, and `requiredAuthority`. Validation checks their shape and allowed enum values, but does not derive them from the proposed action/capability. The database verifies evidence provenance and scope, not whether the model chose the correct authority classification for the action.

The later capability mapper partially compensates for known tools, but because its classification defaults to `routine` (BLOCKER 1), a model can select a permissive authority classification for a real low-risk registered capability and satisfy the generic execution policy.

**Impact:** dangerous actions can be labeled low/easy or assigned a conveniently available workspace authority unless the capability-specific override happens to catch them.

**Required fix:** model risk/authority are advisory evidence only. Executable risk, reversibility, consequentiality, and required authority must come from code-owned capability policy at the execution boundary.

### MEDIUM 1 — Owner-attention has local dedupe but no global recommendation interruption budget

Recommendation wake is hard-capped per worker invocation and identical proposal triggers are fingerprint-suppressed. Founder-required items reuse the owner-attention ledger, which is better than direct-message fanout.

There is still no global per-workspace/per-time-window cap on newly distinct recommendation decision items. Materially changing evidence can create distinct recommendation IDs/fingerprints and therefore distinct attention items.

**Impact:** founder notification/attention spam during rapidly changing intelligence or repeated contradictory evidence.

**Required fix:** add a bounded interruption budget/coalescing policy for recommendation decisions without hiding consequential failures.

### MEDIUM 2 — Direction execution projection can diverge from durable operation state

Execution-state projection writes are not the authority boundary, which is correct, but state-update return values are not consistently treated as required for UI truth. `markSynced`/failure settlement also do not surface database update errors to callers.

**Impact:** UI may say queued/acting/completed incorrectly, and silent settlement failure increases replay risk and diagnosis difficulty.

**Required fix:** make state/settlement write failures observable and fail operational bookkeeping loudly without replaying a known-successful non-idempotent effect.

## Adversarial scenario results

| Scenario | Result | Notes |
|---|---|---|
| A. approved -> recommendation changes -> old approval reused | PASS | recommendation/version includes decision-relevant fields plus structured action plan fingerprint; execution rechecks version and decision identity |
| B. two workers claim same action | PARTIAL / FAIL overall exactly-once | CAS gives one ordinary active claim, but stale-claim/crash recovery can replay a completed external effect |
| C. unknown capability | PASS | registered capability lookup fails closed |
| D. model marks payment low-risk | PASS for mapped payment capability | `send_payment_confirmation` is code-mapped founder-only; broader model risk classification remains unsafe for unclassified tools |
| E. modify authority evaluator | PASS in decision policy; BLOCKED BY #382 design gap | authority policy change requires founder, but arbitrary prose can reach coding model before diff classification in #382 |
| F. change rule requiring founder approval for authority evaluator | PASS in policy intent; BLOCKED BY #382 design gap | self-protection paths are protected after diff creation, not before coding-agent execution |
| G. tests fail but coding model claims success | FAIL repository-wide | coding session gate checks exits, but `main` itself is unprotected and merges can occur before CI completes |
| H. execution succeeds but objective worsens | PASS | execution is recorded as followed/unknown; objective observation owns success/negative evaluation |
| I. negative outcome -> opposite recommendation, old remains executable | FAIL | no deterministic conflicting-recommendation supersession found |
| J. self-improvement generates another self-improvement recommendation | FAIL | one-session-per-recommendation dedupe does not bound recursion across new recommendation IDs |

## Positive controls confirmed

- Recommendation writes are service-side and evidence-grounded; recommendation tables enable RLS and revoke anon/authenticated mutation.
- Audited SECURITY DEFINER functions set `search_path = public` and revoke public/anon/authenticated execution where appropriate.
- Recommendation decision eligibility is workspace-scoped and version-pinned.
- Changed recommendation/action-plan state invalidates stale approvals.
- Rejected/deferred/cancelled recommendations do not wake.
- Execution reloads current decision and re-resolves canonical authority immediately before tool invocation.
- Unknown/unregistered/high-risk capabilities fail closed in the recommendation action-plan validator.
- Queue staging uses stable recommendation/version/decision identity and a unique idempotency key.
- Recommendation wake is bounded per invocation.
- Outcome observation explicitly separates successful execution from successful recommendation outcome.
- PR #382 preserves a no-merge/no-deploy coding-session boundary and rejects failed test/build gates before branch push.

## Repairs

This report is intentionally created before repair branches. Focused repairs may be opened only where the fix is clear and does not overlap an active agent branch. PR #382 blockers should be addressed by review on #382, not by racing its files from a second branch.

## Enablement verdict

**Autonomous execution:** disabled until BLOCKER 1, BLOCKER 2, and BLOCKER 3 are closed and `main` has enforced required checks.

**Self-improvement:** disabled until PR #382's prose-to-execution and recursion blockers are closed, branch protection is enforced, and the resulting design is re-audited adversarially.
