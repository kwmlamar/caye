# Current main observation provenance

- Code revision: `eda98a4547a20ed2c8ccd75d58fec662c1ceffeb`
- Benchmark: `caye-employee-eval/1.0.0`
- Observation date: 2026-09-01
- Method: read-only inspection of the Caye production database plus source architecture inspection.
- ODS: `business_facts=0`, `business_fact_candidates=0`, `caye_work_opportunities=0`; authoritative onboarding exists in `workspace_ai_config`.
- Bimini: `business_facts=28`, `business_fact_candidates=17`, `caye_work_opportunities=0`.
- Bimini pickup contradiction: the old pink-building fact and newer Casino Tram Stop fact were both unsuperseded/current. Relevant legacy rows had `canonical_key=NULL`.
- Replay coverage: current main does not expose an `EmployeeEvalAdapter` capable of replaying these new frozen end-to-end traces against isolated production-equivalent durable memory/opportunity state. Required traces are therefore marked unevaluable. Missing coverage is a hard failure, not a pass.
