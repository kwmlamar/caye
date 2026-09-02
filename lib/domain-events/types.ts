export type DomainActor = {
  kind: 'operator' | 'system' | 'external' | 'unknown'
  id?: string | null
  label?: string | null
}

export type DomainEvidenceRef = {
  kind: string
  ref: string
  metadata?: Record<string, unknown>
}

export type DomainCursor = {
  value: string
  /** Optional authoritative timestamp represented by this cursor/watermark. */
  watermark?: string | null
}

export type ExternalDomainChange = {
  workspaceId: string
  sourceSystem: string
  sourceCompanyId: string
  sourceEntityType: string
  sourceEntityId: string
  sourceEventId?: string | null
  sourceVersion?: string | null
  operation: 'created' | 'updated' | 'deleted' | 'snapshot'
  occurredAt: string
  observedAt: string
  cursor: DomainCursor
  previous: Record<string, unknown> | null
  current: Record<string, unknown> | null
  actor?: DomainActor | null
  evidence?: DomainEvidenceRef | null
  causationId?: string | null
  correlationId?: string | null
  metadata?: Record<string, unknown>
}

export type DomainEntityResolution = {
  entityId: string
  entityType?: string | null
}

export type DomainRelatedEntity = {
  role: string
  sourceEntityType: string
  sourceEntityId: string
  cayeEntityId?: string | null
}

export type DomainFieldChange = {
  field: string
  previous: unknown
  current: unknown
}

export type NormalizedDomainEvent = {
  workspaceId: string
  type: `domain.${string}`
  sourceSystem: string
  sourceCompanyId: string
  sourceEntityType: string
  sourceEntityId: string
  sourceEventId?: string | null
  sourceVersion?: string | null
  cayeEntityId?: string | null
  occurredAt: string
  observedAt: string
  idempotencyKey: string
  actor: DomainActor
  changeKind: 'bootstrap' | 'created' | 'transition' | 'material_change'
  changes: DomainFieldChange[]
  relatedEntities: DomainRelatedEntity[]
  evidence?: DomainEvidenceRef | null
  causationId?: string | null
  correlationId?: string | null
  sourceMetadata: Record<string, unknown>
  snapshot?: Record<string, unknown> | null
  attentionEligible: boolean
}

export type DomainSyncCheckpoint = {
  workspaceId: string
  sourceSystem: string
  sourceCompanyId: string
  stream: string
  cursor: DomainCursor | null
}

export type DomainChangeBatch = {
  changes: ExternalDomainChange[]
  nextCursor: DomainCursor | null
  hasMore: boolean
}

export interface DomainChangeSource {
  readonly sourceSystem: string
  readonly sourceCompanyId: string
  readonly stream: string
  readChanges(after: DomainCursor | null): Promise<DomainChangeBatch>
}

export interface DomainEntityResolver {
  resolve(input: {
    workspaceId: string
    sourceSystem: string
    sourceCompanyId: string
    sourceEntityType: string
    sourceEntityId: string
  }): Promise<DomainEntityResolution | null>
}

export type DomainEventWriteResult =
  | { status: 'inserted'; workspaceEventId: string }
  | { status: 'duplicate'; workspaceEventId?: string }
  | { status: 'stale' }

export interface DomainEventSink {
  write(event: NormalizedDomainEvent): Promise<DomainEventWriteResult>
}

export interface DomainCheckpointStore {
  load(input: {
    workspaceId: string
    sourceSystem: string
    sourceCompanyId: string
    stream: string
  }): Promise<DomainSyncCheckpoint | null>
  commit(checkpoint: DomainSyncCheckpoint): Promise<void>
}
