# Business Entity / Domain Source Kernel

Caye's durable identity and federation layer for operational entities.

> Caye remembers. Models think. Domain systems own the operational state they
> are authoritative for.

## What this is

`business_entities` answers exactly one question: **what business thing is
this, and who is authoritative for its state?**

It answers no other question. There is no `state jsonb`, no `external_record`,
no `metadata` bag, and no mirror of any external row. ODS Construction's real
operational state — projects, payroll, purchase orders, estimates — lives in
Bedrock/TropiTrack and stays there. Caye holds a stable identity for those
things so that facts, events, artifacts, attention, recommendations,
investigations and commitments have something durable to attach to.

Copying Bedrock rows into Caye would make Caye a badly synchronised second copy
of a database it does not own. That failure mode is what this table exists to
prevent, and the absence of a generic state column is the mechanism.

## Authority classes

| Authority | Meaning | Source identity |
| --- | --- | --- |
| `caye_authoritative` | Caye owns the truth (a commitment, a procedure) | forbidden |
| `external_authoritative` | A domain system owns the truth (a Bedrock PO) | required |
| `evidence_only` | Evidence, not operational truth (a Gmail thread) | optional |
| `derived_read_model` | Something Caye computed from either | optional |

The external identity triplet — `source_system` / `source_entity_type` /
`source_entity_id` — is **fully specified or entirely absent**. A partial
identity is rejected by the TypeScript union, by
`public.resolve_business_entity`, and by a table check constraint. It is the
shape that produces duplicate canonical ids under retry, so it is refused three
times over.

## Files

| File | Purpose | Server-only |
| --- | --- | --- |
| `authority.ts` | `DomainAuthority`, `DomainEntityRef` union, normalisation | no |
| `types.ts` | `DomainEntity`, `DomainRelation`, read/mutation adapter ports | no |
| `workspace-events.ts` | How an identity travels on `workspace_events` | no |
| `entities.ts` | `resolveDomainEntity`, `registerCayeEntity`, reads | yes |
| `relations.ts` | `upsertBusinessEntityRelation`, reads, archive | yes |
| `connections.ts` | Workspace to external-tenant binding | yes |
| `resolver.ts` | The narrow resolver the domain event bridge consumes | yes |

Migration: `supabase/migrations/20260901190000_business_entity_kernel.sql`.

## Identity resolution

```ts
const entity = await resolveDomainEntity({
  workspaceId,
  domain: 'construction',
  entityType: 'project',
  authority: 'external_authoritative',
  sourceSystem: 'bedrock',
  sourceEntityType: 'project',
  sourceEntityId: bedrockProjectId,
  displayName: 'Off the Reef',
})
// entity.id is the canonical Caye identity, stable across retries and workers.
```

Concurrency is arbitrated by the unique index
`business_entities_source_identity_key`, not by a select-then-insert in
application code. Two workers resolving the same record at the same instant get
the same uuid; one of them takes the `ON CONFLICT` branch.

Re-resolution may refresh `display_name`, which is presentation. It never
changes `authority`, `domain`, `entity_type` or the source identity — a caller
that disagrees with the stored row gets an exception, because silently
accepting it would let a read-only mirror be relabelled as Caye-owned truth.

`display_name` is nullable on purpose. Identity must be creatable from identity
alone, so a resolver that only holds an external id is never forced to invent a
name in order to obtain a canonical uuid.

Caye-native entities use `registerCayeEntity`. If a native registration needs to
be idempotent, pass an explicit `nativeKey`. Never invent a `sourceSystem` to
get that behaviour: `native_key` is constrained to `caye_authoritative` rows and
external source identity is constrained away from them.

## Relations

`upsertBusinessEntityRelation` asserts one active durable edge. Polling the same
authoritative relationship twenty times produces one edge, because a partial
unique index over active edges arbitrates the conflict — not application memory.

Workspace integrity is structural. `business_entity_relations` references
`business_entities (workspace_id, id)` with composite foreign keys, so an edge
whose subject and object live in different workspaces cannot be inserted, even
through direct SQL, even by code that forgot a `workspace_id` filter.

`relation_type` is free text by design. A construction-specific relation enum
here would make this a construction kernel.

Provenance reuses what Caye already has: `asserted_by` plus an optional
`source_artifact_id` into `business_artifacts` and a `provenance` object. A
relation handed over directly by an authoritative adapter needs no artifact —
`asserted_by = 'domain_adapter'` with a `source_system` already explains it.
No parallel evidence universe is introduced.

## workspace_events

`workspace_events` is **not** changed. It already carries `subject_table` /
`subject_id` plus an open `payload`, which is sufficient.

The convention, stated once in `workspace-events.ts`:

- The domain event bridge writes the resolved identity at
  `payload.entity.caye_entity_id`, and keeps `subject_table` / `subject_id`
  pinned to the external record. That is correct: the subject of the event is a
  Bedrock purchase order; the Caye identity is how Caye files it.
- Events whose subject really is the Caye identity itself (registered, merged,
  archived) use `subject_table = 'business_entities'`.

`businessEntityIdFromWorkspaceEvent()` reads both and returns `null` when an
event carries no identity. It never falls back to an external id, because an
external id is not a Caye identity.

## Domain source connections

`domain_source_connections` binds a workspace to an external tenant, one row per
`(workspace, source_system)`.

This is the **only** place a source system's company/tenant identifier belongs.
Entity identity is deliberately free of it, so rotating credentials, pausing a
connection, or replacing the connection implementation cannot change what a
business entity *is*.

No secrets live here. `credential_ref` is a *name* resolved against the
server-side secret store; a check constraint rejects anything that does not look
like an identifier, and a second constraint rejects a `config` object carrying
common secret keys. Storing a real key fails rather than succeeding quietly.

## Integration seams

**Domain read adapters** (e.g. the Bedrock adapter) conform to the kernel
without flattening their typed objects. An adapter's authority metadata maps to
`DomainEntityRef`:

```ts
const ref: DomainEntityRef = {
  workspaceId: bedrockObject.workspaceId,
  domain: 'construction',
  entityType: bedrockObject.sourceEntityType,
  authority: 'external_authoritative',
  sourceSystem: bedrockObject.sourceSystem,
  sourceEntityType: bedrockObject.sourceEntityType,
  sourceEntityId: bedrockObject.sourceEntityId,
}
```

The kernel answers *what business thing is this*. The adapter answers *what is
its authoritative state right now*, in its own typed shape — which is why
`DomainReadAdapter<TState>` is generic rather than returning JSON. Implementing
`DomainReadAdapter` grants no authority to write: mutation is a separate
capability (`DomainMutationAdapter`) with no generic implementation here.

An adapter's transitional connection resolver can be replaced with
`createDomainConnectionResolver('bedrock')`, which returns the tenant id and
credential *reference*. Materialising the credential stays with the adapter, so
the kernel never holds a key even transiently.

**The domain event bridge** consumes `createKernelEntityResolver`, which is
structurally identical to the bridge's own `DomainEntityResolver` port:

```ts
const resolver = createKernelEntityResolver({ domain: 'construction' })
const { entityId } = (await resolver.resolve({
  workspaceId, sourceSystem, sourceCompanyId, sourceEntityType, sourceEntityId,
}))!
```

`sourceCompanyId` is accepted but is **not** part of entity identity. It is
checked against the workspace's recorded binding (`tenantCheck`, default
`'when_bound'`) and otherwise ignored, so a change tagged with a tenant this
workspace is not bound to fails loudly instead of being filed under the wrong
business.

## Access

Service-role only, like the rest of Caye's back-office tables. RLS is enabled
with zero policies on all three tables: that is the intended deny-by-default
state, not an unfinished job. A future client-side reader should fail loudly and
get an explicit, reviewed policy rather than inherit one by accident.
