# Caye Employee Eval PR policy

Local/unit/integration tests are necessary but not sufficient evidence that a change to Caye's employee behavior is successful.

For pull requests, `.github/workflows/employee-eval-ci.yml` runs on every PR. The gate conservatively treats runtime changes as employee-behavior-sensitive unless every changed file is clearly limited to evaluator infrastructure, CI, documentation, or test-only code.

A behavior-sensitive PR must:

1. run the frozen `caye-employee-eval/1.0.0` ODS and Bimini scenarios against the PR implementation through an `EmployeeEvalAdapter`;
2. write the machine-readable candidate report and human-readable scorecard;
3. compare that candidate report against the frozen current-main baseline using the exact same benchmark version;
4. publish the aggregate score delta, every per-dimension delta, new hard failures, and fixed hard failures in the GitHub Actions step summary;
5. upload the candidate report, scorecard, and comparison as workflow artifacts.

The comparison automatically fails if the benchmark versions are not identical or the candidate introduces a new hard failure.

If a behavior-sensitive PR cannot run the frozen scenarios against observable durable state and effects, the gate fails. Missing candidate coverage is not success and the baseline report is not accepted as a substitute for a candidate run.

The default adapter module is `lib/caye-employee-eval/production-adapter.ts`, exporting `employeeEvalAdapter`. A different adapter may be supplied with `CAYE_EMPLOYEE_EVAL_ADAPTER_MODULE`, but it must implement the state-first `EmployeeEvalAdapter` contract and produce a report for the PR's exact head revision.
