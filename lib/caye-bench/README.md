# Caye Bench v1

Caye Bench is the deterministic operational-evaluation substrate for Caye.
It is intentionally separate from production execution and from narrow unit tests.

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

`BenchAdapter` is the seam between a simulated world and Caye.

`ScriptedBenchAdapter` exists only to test the harness and deterministic fixtures. It must not be used to claim a real Caye operational score.

The next adapter should call Caye's real execution paths against an isolated simulated state/provider layer. The benchmark types deliberately make that an adapter addition rather than a rewrite of the runner.

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

The scenario catalog is executable, but its scores only become product evidence when paired with a production-path adapter.

## Simulation direction

Caye Bench v1 is the replay/evaluation layer, not the final simulation system. Future synthetic-world engines should preserve the same core ideas: deterministic seed, explicit world state, virtual time, event/effect provenance, interventions, hard invariants, quality metrics, and machine-readable reports.
