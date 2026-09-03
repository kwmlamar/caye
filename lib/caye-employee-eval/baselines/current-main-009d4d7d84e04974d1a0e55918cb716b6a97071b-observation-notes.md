# Current main observation provenance — 009d4d7d

- Code revision: `009d4d7d84e04974d1a0e55918cb716b6a97071b`
- Benchmark: `caye-employee-eval/1.0.0`
- Observation date: 2026-09-03
- Method: `npx vitest run lib/caye-employee-eval/candidate-runner.test.ts` against the
  isolated production adapter (PGlite in-memory Postgres, mocked Supabase client and
  LLM extraction). No production database was read or written at any point.
- Primary evidence: GitHub Actions run `33711931180`, artifact `9877220985`,
  SHA-256 `f00d498cbc3340ca8e2ff5a4a3f35a023d3ac173fc307b89aecc50890602812f`.
- Independently reproduced by a local run at the same revision. Both runs agree on all
  fifteen dimensions, the 2.5 aggregate, and the single remaining hard failure.
- `required_trace_unevaluable` is resolved: the adapter returns real facts, retrievals
  and traces instead of hand-authored unevaluable placeholders.
- `authoritative_correction_ignored` remains, and is now reproducible on a fresh
  in-memory database rather than only observable as legacy production data:
  `sales.quote.fee: old superseded=false current rows=0`. An authoritative correction
  neither superseded the stale fact nor wrote the replacement.
- ODS onboarding facts never reach durable memory. `business.owner.name`,
  `business.identity.name` and `business.service_category` all return `found=0` despite
  authoritative onboarding existing in `workspace_ai_config`.
- The comparison reference used by the gate remains `CURRENT_MAIN_BASELINE_SNAPSHOTS`
  in `lib/caye-employee-eval/baseline-current-main.ts`, still pinned to `eda98a45`.
  This file is evidence for `009d4d7d`; it does not change what the gate compares
  against. Rolling that reference forward is a separate, deliberate decision.
