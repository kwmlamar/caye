# Project / Experiment Intelligence v0.1

CAY-26 adds a durable engineering-change layer on top of Property Intelligence. Property Intelligence answers what exists and what is currently known. Project Intelligence answers what we are trying to change, why, what we predict, what a human actually changed, and whether the evidence says it worked.

## Lifecycle

`property observations → project objective → frozen baseline → candidate alternatives → founder selection → human execution evidence → property outcome observations → deterministic comparison → evidence-grounded verdict`

The project model is not a generic task tracker and does not own physical truth. Baselines and outcomes reference Property Intelligence observations instead of copying numbers into project prose.

## Truth boundaries

- A project is intent, not authorization to act.
- A selected alternative is a decision record, not proof of code compliance, structural/electrical safety, potability, or professional approval.
- Predictions are predictions. Model-facing prediction provenance is limited to `operator_confirmed`, `inferred`, or `estimated`.
- Execution can only be recorded against the current inbound founder Direct message, optionally with an artifact or installed asset. Assistant text alone cannot prove physical work happened.
- Outcome metrics reference existing numeric Property Intelligence observations with their original provenance.
- Conclusive verdicts require at least one linked outcome observation. With insufficient evidence, the only valid verdict is `inconclusive`.
- Frozen baselines are immutable. Corrections become a new baseline revision before execution, never a rewrite of frozen history.
- V0.1 has no purchasing, contractor booking, IoT/device control, or physical actuation.

## Comparison

Prediction-versus-actual comparison is deterministic. Metric keys must match and units must be exactly compatible after simple normalization. V0.1 intentionally performs no implicit unit conversion; a gallon prediction and liter observation are reported as incompatible rather than handed to the model for arithmetic improvisation.

## Founder Direct

Founder-only Direct tools can create/read projects, freeze baselines from explicit property observations, add revised alternatives and predictions, record a founder selection, record externally grounded execution evidence, link outcome observations, compare predicted versus actual metrics, and record an evidence-grounded verdict.

A trusted `engineering_project` rich-result block is derived only after a successful `get_engineering_project` tool execution. Model-authored rich-result JSON cannot manufacture a project card.

## First fixture

The first regression fixture is a generic water-resilience property shaped like the founder test case: two storage tanks, incomplete catchment, estimated roof area, design occupancy, and delivered-water cost. Tests must not depend on the production property UUID or production rows.
