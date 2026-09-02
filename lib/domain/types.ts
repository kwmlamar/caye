/**
 * Generic domain contracts shared by the kernel and by domain adapters.
 *
 * Kept deliberately small. This is not a universal domain model: it is the
 * vocabulary needed to say "this is a business thing, here is who is
 * authoritative for it, and here is how to ask them". Domain-specific state
 * stays in the adapter's own typed objects (a Bedrock purchase order is a
 * `BedrockPurchaseOrder`, not a bag of JSON), which is why `getCurrentState`
 * is generic over `TState` rather than returning a blob.
 */

import type { DomainAuthority, DomainEntityRef, DomainSourceIdentity } from './authority'

/** A canonical business entity identity as Caye stores it. */
export interface DomainEntity {
  /** The canonical Caye uuid. This is the stable subject identity. */
  id: string
  workspaceId: string
  domain: string
  entityType: string
  displayName: string | null
  authority: DomainAuthority
  /** Present exactly when the entity is bound to an external source record. */
  source: DomainSourceIdentity | null
  nativeKey: string | null
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

export type DomainRelationAssertedBy =
  | 'domain_adapter'
  | 'caye_inference'
  | 'operator'
  | 'founder'
  | 'system'

/** A durable relationship between two canonical identities in one workspace. */
export interface DomainRelation {
  id: string
  workspaceId: string
  subjectEntityId: string
  objectEntityId: string
  relationType: string
  status: 'active' | 'archived'
  assertedBy: DomainRelationAssertedBy
  /** Set when an authoritative adapter asserted the edge. */
  sourceSystem: string | null
  /** Existing Caye evidence, when the belief came from an artifact rather than an adapter. */
  sourceArtifactId: string | null
  provenance: Record<string, unknown>
  confidence: number | null
  firstAssertedAt: string
  lastAssertedAt: string
}

export interface DomainEntityQuery {
  workspaceId: string
  domain?: string
  entityType?: string
  authority?: DomainAuthority
  sourceSystem?: string
  status?: 'active' | 'archived'
  limit?: number
}

export interface DomainRelationQuery {
  relationType?: string
  /** Which side of the edge the reference sits on. Defaults to 'subject'. */
  direction?: 'subject' | 'object' | 'either'
  status?: 'active' | 'archived'
  limit?: number
}

export interface DomainTimelineEntry {
  occurredAt: string
  /** Adapter-defined, e.g. 'status_changed'. Never a Caye internal queue or tool name. */
  kind: string
  summary: string
  source: DomainSourceIdentity
  details?: Record<string, unknown>
}

export interface DomainTimelineOptions {
  since?: string
  until?: string
  limit?: number
}

export interface DomainAdapterHealth {
  domain: string
  sourceSystem: string
  status: 'healthy' | 'degraded' | 'unavailable'
  checkedAt: string
  detail?: string
}

/**
 * Reading authoritative state from a domain system.
 *
 * Implementing this grants no authority to change anything. That separation is
 * the point: mutation lives in `DomainMutationAdapter` so a read integration
 * can never accidentally become a write integration.
 */
export interface DomainReadAdapter<TState = unknown> {
  readonly domain: string

  getEntity(ref: DomainEntityRef): Promise<DomainEntity | null>

  findEntities(query: DomainEntityQuery): Promise<readonly DomainEntity[]>

  /** Current authoritative state, in the adapter's own typed shape. */
  getCurrentState(ref: DomainEntityRef): Promise<TState | null>

  getRelatedEntities(ref: DomainEntityRef, query?: DomainRelationQuery): Promise<readonly DomainRelation[]>

  getTimeline?(ref: DomainEntityRef, options?: DomainTimelineOptions): Promise<readonly DomainTimelineEntry[]>

  healthCheck?(): Promise<DomainAdapterHealth>
}

/**
 * Mutating a domain system. Intentionally a separate capability with no
 * generic implementation in this kernel: consequential writes go through
 * Caye's existing authority and confirmation architecture, not through a
 * generic escape hatch.
 */
export interface DomainMutationAdapter<TCommand = unknown, TResult = unknown> {
  readonly domain: string
  mutate(command: TCommand): Promise<TResult>
}
