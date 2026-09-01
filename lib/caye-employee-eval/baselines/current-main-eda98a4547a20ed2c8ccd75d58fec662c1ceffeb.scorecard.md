# Caye Employee Eval current-main baseline

Benchmark: `caye-employee-eval/1.0.0`

Evaluated code revision: `eda98a4547a20ed2c8ccd75d58fec662c1ceffeb`

Evaluator revision: `3a999a6ba962990d28cc909c3bacb7121367cf8f`

Overall: **0.9/10 — FAIL**

Hard failures: `required_trace_unevaluable`, `authoritative_correction_ignored`.

| Dimension | Score | Result |
| --- | ---: | --- |
| onboarding_learning | 0.0 | FAIL |
| continuous_learning | 0.0 | FAIL |
| memory_correctness | 0.0 | FAIL |
| contradiction_handling | 0.0 | FAIL |
| provenance_authority | 0.3 | FAIL |
| retrieval_quality | 0.9 | FAIL |
| proactive_opportunity_detection | 0.0 | FAIL |
| economic_relevance | 1.4 | FAIL |
| autonomous_execution | 1.9 | FAIL |
| human_interruption_quality | 2.3 | FAIL |
| task_completion | 0.0 | FAIL |
| workspace_context_isolation | 0.0 | FAIL |
| temporal_reasoning | 0.0 | FAIL |
| failure_recovery | 6.7 | FAIL |
| observability | 0.0 | FAIL |

## Failure counts by subsystem

| Subsystem | Failing assertions |
| --- | ---: |
| coverage | 2 |
| memory | 170 |
| temporal | 2 |
| learning_pipeline | 114 |
| opportunities | 24 |
| execution | 12 |
| attention | 6 |
| task_completion | 6 |
| economics | 11 |
| isolation | 1 |
| failure_recovery | 1 |

The complete generated scorecard contains every failing assertion, grouped by subsystem. It is produced by `npm run caye:employee:eval` from the frozen v1 observations and thresholds. GitHub Actions run `33481667910`, artifact `9790162675`, SHA-256 `1b9d77d028edb699191e073da23ee2c20cd6603ab21ba5ab70e3f0c02ccd7307` is the immutable generation evidence for this summary.

Both scenario economic ledgers are zero in the baseline. This is intentional evidence, not a neutral default: the current system cannot demonstrate the benchmarked workload reduction/revenue protection through an evaluable end-to-end replay.
