# Bedrock → Caye domain integration

Reconciles three independently built pieces onto one path:

- **Business Entity / Domain Source Kernel** (`lib/domain`) — identity and federation.
- **Bedrock read adapter** (`lib/domain-adapters/bedrock`) — typed, read-only, company-scoped.
- **Domain event projection bridge** (`lib/domain-events`) — normalisation and projection.

```
Caye workspace
     └─ domain_source_connections        which Bedrock company, which credential
          └─ KernelBedrockConnectionResolver
               └─ SupabaseBedrockReadProvider          company-scoped reads only
                    ├─ BedrockAdapter                  current authoritative state
                    └─ BedrockPurchaseOrderChangeSource
                         └─ ExternalDomainChange
                              └─ runDomainEventBridge
                                   ├─ createKernelEntityResolver → business_entities.id
                                   └─ ingest_external_domain_event → workspace_events
                                        └─ existing continuous perception
```

## What is authoritative where

Caye stores that purchase order X **exists** and that a transition **happened**.
Bedrock answers what purchase order X **is now**. `business_entities` carries no
operational state, and nothing on this path reads PO status from it — the
end-to-end test asserts both.

A projected event is not a fact. `domain.purchase_order.status_changed` lands in
`workspace_events` and stops there; no `business_facts` row is written.

## Load-bearing decisions

**Bootstrap is observation, not history.** A PO seen for the first time emits
`domain.purchase_order.bootstrap_observed` with no field changes and
`actor_kind = 'system'`. The actor matters as much as the flag: the existing
workspace feed raises events by `actor_kind = 'outside'`, so a backfill
attributed to the outside world would announce every pre-existing record as
fresh activity the first time a source is connected.

**`updated_at` is trusted only because a trigger maintains it.** Bedrock's
`purchase_orders` has `set_updated_at BEFORE UPDATE`. The cursor is the
`(updated_at, id)` pair, because `updated_at` alone is not a total order and
would either skip or re-read rows forever.

**A moved `updated_at` is not a change.** Events come from a fingerprint over
`PURCHASE_ORDER_TRACKED_FIELDS`, so an edit to a note or an OCR blob produces
nothing.

**Observation state is committed with the cursor, never before it.**
`withPendingObservationFlush` flushes staged snapshots immediately before the
checkpoint advances. The reverse order would let a failure between reading and
projecting leave Caye believing it had accounted for a change it never emitted —
which is invisible forever, because the next poll sees no difference.

**Tenant binding is not identity.** `external_tenant_id` (the Bedrock company)
lives on the connection, never in `business_entities`, so re-pointing a
connection cannot change what a business entity IS.

## `unique (workspace_id, source_system)` — retained

One Bedrock connection per workspace, as the kernel shipped it. Retained
deliberately, not by default:

- `BedrockConnection` carries exactly one `companyId`, and the adapter has no
  notion of choosing among several;
- the live Bedrock database has a single `companies` row, and ODS is one
  business;
- a workspace federating two Bedrock companies would need a selection rule
  everywhere a workspace id is used today, which is a product decision nobody
  has made.

Relaxing it later is an additive migration plus a selection argument. Widening
it now would add that argument to every call site to serve no current caller.

## Deliberately not built

Connection rows are seeded by migration or by hand for now — no admin UI, no
onboarding flow. Writes to Bedrock, other entity streams (project, estimate,
receipt, payroll), attention/commitment generation, and any procurement product
surface are all out of scope for this pass.
