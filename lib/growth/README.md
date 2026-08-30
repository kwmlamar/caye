# Growth Intelligence v1

Caye's growth loop is deliberately evidence-first:

`OBSERVE -> UNDERSTAND -> DIAGNOSE -> RECOMMEND`

This phase does not execute marketing actions.

## Trust invariants

- Every observation is workspace-scoped and carries provenance.
- A disconnected or failed provider is **unknown/unavailable**, never a zero metric.
- Diagnoses cite observation ids and record missing sources.
- Recommendations must reference a stored diagnosis.
- `growth.snapshot` is read-only and cannot cross an execution boundary.
- Bimini Island Tours is the first deployment, not a special-case implementation.

## Initial sources

The normalized schema supports GA4, Search Console, bookings, inquiries, and manual observations. Provider OAuth/fetch adapters can be added independently without changing the diagnosis contract.