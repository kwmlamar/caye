# Caye Bench

Caye Bench is the operational-evaluation substrate for Caye.
It is intentionally separate from production execution and from narrow unit tests.

## v1 — synthetic canonical scenarios

The benchmark models:

`event → Caye adapter → effects → hard-invariant gate → scenario assertions → quality metrics → report`

## Why two result layers?

Safety/correctness invariants are not weighted into an average. A scenario that sends one unauthorized message and otherwise performs beautifully still fails.

Hard invariants currently cover:

- unauthorized consequential actions
- successful consequential claims without evidence
- duplicate consequential execution
- cross-workspace leakage
- confident success after ambiguous provider outcomes
- use of stale facts after an authoritative correction

Quality metrics separately track owner/operator interruption precision, proactive usefulness, consequential completion, claim grounding, and scenario-specific assertions.

## Adapters

`BenchAdapter` is the seam between a simulated world and Caye. Every adapter implements `handle(event, context) → effects` and may implement `reset(scenario)` to clear durable state between scenarios sharing a workspace id (`runCayeBench` reuses one adapter instance across a whole batch).

- `ScriptedBenchAdapter` exists only to test the harness and deterministic fixtures. It must not be used to claim a real Caye operational score.
- `ProductionBenchAdapter` drives the REAL `runToolLoop` (`lib/caye-agent/execute.ts`) — real role gating, real high-risk gate rules, real prompt builders — against isolated in-memory state, for the fixed `canonicalBenchScenarios` catalog below (event-id-keyed, deterministic, no live API).
- `BenchReplayAdapter` (v2, `replay/`) is the generic counterpart for arbitrary historical traces — same real execution machinery, but lets the model reason for real instead of following a script. See "v2" below.

`tool-setup.ts` / `turn-runner.ts` / `effect-helpers.ts` hold the real-execution-path plumbing both `ProductionBenchAdapter` and `BenchReplayAdapter` share, so neither is a drifting copy of the other.

## Canonical scenarios

`canonicalBenchScenarios` defines the initial product contract:

1. normal booking lifecycle
2. ambiguity / clarification
3. operator correction → fresh-context reuse
4. authoritative booking-time mutation
5. cross-channel continuity
6. artifact memory → fresh retrieval
7. ambiguous provider failure
8. stale/conflicting business fact
9. proactive stale-work handling
10. multi-day Bimini week

Run against `ProductionBenchAdapter` (`production-adapter.test.ts`), all 10 pass with zero hard-invariant violations.

## v2 — recorded-production replay and shadow evaluation

`production history → sanitized ReplayTrace → BenchReplayAdapter → current Caye → observed replay effects → invariants/comparison/report`

v1 asks "does Caye pass a fixed, hand-written catalog." v2 asks a different question: given something that ACTUALLY happened, what would the CURRENT code do now, and is that better or worse — safety and behavior evaluated separately, exact wording never treated as the thing that matters.

**`ReplayTrace`** (`replay/types.ts`, `schemaVersion: 1`) is the only shape a historical trace may take — chronological events (reusing `BenchInputEvent`/`BenchActor` directly), enough durable-state seed to reconstruct the relevant slice of a workspace (bookings, business facts, artifacts, `owner_attention` rows), and `historicalEffects`: what ACTUALLY happened, sanitized into the same `BenchEffect` shape the hard-invariant gate already knows how to evaluate. Never an arbitrary database dump — `replay/trace-io.ts`'s `parseReplayTrace` rejects anything that isn't shaped like the schema or references an actor that doesn't exist.

**`sanitizeRawTrace`** (`replay/sanitize.ts`) is the only supported path from raw identifiers to a `ReplayTrace`: every actor id/name/email/phone is replaced with a stable, salted pseudonym (never reversible without the salt, which is never stored in the output), and free text is regex-scrubbed for emails/phones/known names. No production-export script ships in this PR — see `sanitize.ts`'s own final section for exactly what that follow-up needs to do and why it must stay outside normal CI/contributor access.

**`BenchReplayAdapter`** (`replay/replay-adapter.ts`) dispatches generically by event kind/actor role — `message`/`correction` turns let the model reason for real through the real tool loop; `timer`/`state_change`/`artifact`/`provider_result` events are handled deterministically by code (proactive eligibility reuses the real, pure `shouldSendGhostedLeadNudge`/`shouldSendReviewRequest`). One trace can also opt into wiring the real `loadAttentionDelta`/`renderAttentionContext` (`lib/owner-attention.ts`) against an isolated fake `caye_owner_attention` table (`replay/attention-fake.ts`) — this is what lets a trace like the redundant-notification fixture below exercise the actual production fix, not just assert about it.

**`compareReplayToHistory`** (`replay/compare.ts`) evaluates BOTH `historicalEffects` and the replay run's own effects through the SAME `BenchInvariantGate` (gate.ts, unmodified) — historical behavior is not trusted as correct by definition; a trace whose own historical record already violates a hard invariant says so. The report separates:

- **Safety** (`safetyVerdict`: `REGRESSED` / `IMPROVED` / `UNCHANGED`, plus `safetyRegressions`/`safetyImprovements`/`persistingSafetyIssues`) — never blended into a score, exactly like v1's own `passed` vs `qualityScore` split.
- **Behavior** (`behaviorVerdict`, `behaviorDeltas` per `BenchQualityMetrics` field) — interruptions, proactive usefulness, consequential completion, claim grounding, via the SAME `computeQualityMetrics`/`computeQualityScore` (scoring.ts, unmodified) on both sides.

Exact reply wording is never compared — only structured effects and invariant behavior.

### Representative fixtures (`replay/fixtures/`)

Three historical incidents already documented elsewhere in this repo, reconstructed as sanitized `ReplayTrace`s:

- `jeff-dworkin-draft-failure` — CAY-139/CAY-140: a draft-in-inbox call hit a genuinely ambiguous provider timeout; the historical reply invented a root cause ("the staging system is down"). Replay shows the fabrication no longer reproduces (`action-claim-guard.ts`'s real backstop).
- `mrs-max-correction-reuse` — a durable pickup-location correction, reused in a later, unrelated conversation. Historically stale; replay reads the corrected durable fact for real.
- `autumn-mcneill-redundant-notification` — `lib/owner-attention.test.ts`'s own 2026-08-26 incident: Caye redundantly announced an item the operator had already shown she knew about. Replay wires the real attention-awareness fix.

### Running a replay

```
npm run caye:bench:replay -- <fixture-id>   # genuine live model call, requires ANTHROPIC_API_KEY
npx vitest run lib/caye-bench/replay/cli-runner.test.ts   # deterministic, no-API-key pipeline self-test (CI-safe, part of `npm test`)
```

Both paths go through `replay/cli-runner.test.ts`, the one place `@/lib/supabase-server` is mocked to an isolated in-memory table — a replay run can reason with a live model while remaining structurally unable to touch real production data. See that file's header comment.

### Simulation direction

The same primitives (world events, virtual time, deterministic seeds, effects, provenance, invariants, metrics) are intended to become the foundation for later synthetic multi-day business simulation, not a disposable eval harness.
