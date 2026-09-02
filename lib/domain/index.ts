/**
 * Business Entity / Domain Source Kernel.
 *
 * Caye's durable identity and federation layer for operational entities. See
 * lib/domain/README.md for the boundary this draws between Caye's intelligence
 * and the domain systems that own operational state.
 *
 * `authority`, `types` and `workspace-events` are pure and safe to import
 * anywhere. `entities`, `relations`, `connections` and `resolver` are
 * server-only, so they are re-exported here rather than pulled in eagerly by
 * anything that only needs the contracts.
 */

export {
  DOMAIN_AUTHORITIES,
  DomainIdentityError,
  domainSourceIdentityKey,
  isDomainAuthority,
  normalizeDomainEntityRef,
  readDomainSourceIdentity,
  type CayeDomainEntityRef,
  type DomainAuthority,
  type DomainEntityRef,
  type DomainEntityRefBase,
  type DomainSourceIdentity,
  type ExternalDomainEntityRef,
  type NoDomainSourceIdentity,
  type NormalizedDomainEntityRef,
} from './authority'

export type {
  DomainAdapterHealth,
  DomainEntity,
  DomainEntityQuery,
  DomainMutationAdapter,
  DomainReadAdapter,
  DomainRelation,
  DomainRelationAssertedBy,
  DomainRelationQuery,
  DomainTimelineEntry,
  DomainTimelineOptions,
} from './types'

export {
  BUSINESS_ENTITY_SUBJECT_TABLE,
  businessEntityIdFromWorkspaceEvent,
  businessEntitySubject,
  workspaceEventEntityRef,
  type BusinessEntityResolutionState,
  type WorkspaceEventEntityRef,
} from './workspace-events'

export {
  BUSINESS_ENTITIES_TABLE,
  findBusinessEntities,
  findBusinessEntityBySource,
  getBusinessEntity,
  registerCayeEntity,
  resolveDomainEntity,
  toDomainEntity,
  type RegisterCayeEntityInput,
  type ResolveDomainEntityInput,
} from './entities'

export {
  BUSINESS_ENTITY_RELATIONS_TABLE,
  archiveBusinessEntityRelation,
  findBusinessEntityRelations,
  toDomainRelation,
  upsertBusinessEntityRelation,
  type UpsertBusinessEntityRelationInput,
} from './relations'

export {
  DOMAIN_SOURCE_CONNECTIONS_TABLE,
  createDomainConnectionResolver,
  getDomainSourceConnection,
  listDomainSourceConnections,
  type DomainConnectionResolver,
  type DomainSourceConnection,
  type DomainSourceConnectionStatus,
} from './connections'

export {
  createKernelEntityResolver,
  type DomainEntityResolutionInput,
  type DomainEntityResolutionResult,
  type DomainEntityResolverPort,
  type KernelEntityResolverOptions,
} from './resolver'
