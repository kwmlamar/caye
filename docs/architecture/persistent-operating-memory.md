# Persistent operating memory

## Decision

Caye does not get a second "Jarvis memory" database.

The existing `business_facts` + operator-learning stack is the durable contextual-knowledge spine and is extended with typed memory semantics. Domain-specific systems remain authoritative for their own state. Vector search, if added later, is an index over authoritative records, never the source of truth.

## Existing memory mechanisms audited

### `business_facts`

Existing durable workspace knowledge. Already had expiration, supersession, canonical keys, service scope, source and creator fields. This remains the canonical durable contextual-memory store.

### `business_fact_candidates`

Quarantine for proposed/untrusted learning. Inferred or ambiguous knowledge belongs here until authority is sufficient. This prevents an LLM inference from silently becoming policy.

### `operator_learning_audit`

Durable audit of learning decisions, source operator/message/conversation, classifier result, route, write target, supersession and reason. This remains the learning decision trail.

### `business_artifacts`, `business_artifact_observations`, `business_artifact_relations`

Evidence/artifact graph with source/provenance/confidence concepts. These are evidence and operational artifacts, not a competing memory store.

### Specialized authoritative stores

Examples found during the audit include:

- service pricing and availability tables
- operator/contact authorization state
- property/business artifact state
- `engineering_project_decisions`
- `engineering_project_outcomes`
- `job_search_profile_facts`

These remain domain systems of record. Typed operating memory may reference or summarize them, but it must not override current authoritative state.

## Typed memory model

`business_facts` is enriched with:

- `memory_type`: fact, preference, procedure, policy, decision, correction, operating_pattern, outcome, assumption, prior_work
- `subject_type`: workspace, person, organization, property, project, system_asset, service, customer
- `subject_id`
- `knowledge_mode`: explicit, observed, inferred, derived
- `confidence`
- `valid_from` / existing `expires_at`
- `sensitivity`: workspace, restricted, private
- `authority_kind`: owner, founder, operator, system, external_source, inference
- structured `provenance`
- contradiction and correction lineage

The table remains workspace scoped. Subject scope is an additional boundary, never a replacement for workspace scope.

## Authority rules

1. An inferred/derived memory may not supersede explicit/observed memory.
2. Ambiguous contradictions become candidates rather than live writes.
3. Cross-workspace supersession, contradiction and correction links are rejected in SQL.
4. Generic retrieval excludes private memory completely.
5. Restricted memory requires an explicit retrieval opt-in and the RPC remains service-role only.
6. Current system-of-record state wins over contextual memory when they disagree.
7. Confidence affects ranking, not authority.

## Retrieval

`retrieve_operating_memory` performs deterministic workspace-bound retrieval and excludes:

- superseded rows
- expired rows
- rows whose `valid_from` is in the future
- unauthorized sensitivity levels
- nonmatching subject/memory filters

Ranking uses exact canonical-key/text/category relevance, confidence, knowledge mode and recency. This is intentionally not an undifferentiated embedding dump.

The live front desk now obtains business facts through this RPC. Returned subject scope is retained in prompt rendering so service/person/customer/project/property memory cannot quietly become workspace-wide policy.

## End-to-end learning loop

The implemented loop reuses the existing operator-learning workflow:

1. Operator sends a reusable statement or correction.
2. Existing prefilter/classifier determines explicitness, risk, scope, canonical topic and destination.
3. Existing deterministic authority/routing gate decides live write vs candidate/no-op.
4. Business-fact writer runs existing conflict and semantic same-topic checks.
5. Typed atomic writer records the correction, provenance, confidence, authority and correction/contradiction lineage while superseding the prior row when appropriate.
6. `operator_learning_audit` records the learning decision.
7. A later customer turn calls `fetchBusinessFacts()`.
8. The typed retrieval RPC returns only current authorized memory for that workspace.
9. The front-desk prompt receives the corrected fact and explicit subject boundary.

That is the required correction -> durable learning -> future retrieval -> behavior improvement loop.

## Bad-memory containment

- malformed confidence is rejected from rendered operating-memory context
- retrieval failure fails closed
- ambiguous conflict does not write
- consequential service-scoped facts fail to candidate if service grounding fails
- inferred/derived memory cannot erase explicit/observed memory
- scope labels survive retrieval into prompt context
- historical rows remain auditable through supersession rather than deletion

## Direction evidence

`caye_memory_capability_evidence` exposes aggregate counts only:

- active memories
- active memory types
- correction-chain links
- memories carrying provenance
- latest memory timestamp
- audited learning writes

The view is `service_role` only. Direction can use these aggregates as capability evidence without reading memory contents.

## Future work

- add explicit subject registries/foreign-key adapters where stable identifiers exist across people, organizations, properties, projects and assets
- correlate outcome memory with objective/execution runs without making outcomes self-authorizing policy
- add semantic retrieval as a secondary ranking/index layer once deterministic filters and provenance remain mandatory
- add dedicated private-memory retrieval paths only when an actor/authority model explicitly requires them
