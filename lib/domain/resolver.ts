import 'server-only'

import { DomainIdentityError } from './authority'
import { getDomainSourceConnection } from './connections'
import { resolveDomainEntity } from './entities'

/**
 * The narrow resolver the external domain event bridge consumes.
 *
 * The bridge knows a source system, a source tenant and a source record. It
 * does not know Caye's `domain` taxonomy, so the domain is bound here, at
 * construction, by whoever wires an adapter to the kernel.
 *
 * `sourceCompanyId` is accepted but is NOT part of entity identity. Tenant
 * binding lives on `domain_source_connections`; folding it into identity would
 * mean a Bedrock project changed identity when its connection was re-pointed,
 * which is exactly the coupling this kernel exists to avoid. It is used only
 * as a safety check against the workspace's recorded binding.
 */

export interface DomainEntityResolutionInput {
  workspaceId: string
  sourceSystem: string
  sourceCompanyId: string
  sourceEntityType: string
  sourceEntityId: string
  /** Optional presentation. Omitting it never blanks a name already on record. */
  displayName?: string | null
}

export interface DomainEntityResolutionResult {
  entityId: string
  entityType: string | null
}

/**
 * Structurally identical to the bridge's own `DomainEntityResolver`, declared
 * here so the kernel does not depend on the bridge and the bridge does not
 * depend on the kernel's internals. Either can import the other's type; the
 * shapes match.
 */
export interface DomainEntityResolverPort {
  resolve(input: DomainEntityResolutionInput): Promise<DomainEntityResolutionResult | null>
}

export interface KernelEntityResolverOptions {
  /** Caye's domain taxonomy value, e.g. 'construction'. */
  domain: string
  /**
   * Maps a source entity type onto Caye's `entity_type`. Defaults to identity,
   * which is right whenever the source's vocabulary is already the one Caye
   * should use.
   */
  entityTypeFor?: (sourceEntityType: string) => string
  /**
   * Tenant checking against `domain_source_connections`:
   *  - 'when_bound' (default) verifies only if the workspace has a connection
   *    row, so the kernel works before connections are populated;
   *  - 'always' requires a matching connection row;
   *  - 'never' skips the check.
   */
  tenantCheck?: 'when_bound' | 'always' | 'never'
}

/**
 * Builds a resolver that turns an external identity into a stable canonical
 * Caye entity id, registering it on first sight. Idempotent and concurrency
 * safe: the guarantee comes from the unique index behind
 * `public.resolve_business_entity`, not from this function.
 */
export function createKernelEntityResolver(
  options: KernelEntityResolverOptions
): DomainEntityResolverPort {
  const domain = options.domain?.trim().toLowerCase()
  if (!domain) throw new DomainIdentityError('a kernel entity resolver requires a domain')

  const entityTypeFor = options.entityTypeFor ?? ((sourceEntityType: string) => sourceEntityType)
  const tenantCheck = options.tenantCheck ?? 'when_bound'

  return {
    async resolve(input: DomainEntityResolutionInput): Promise<DomainEntityResolutionResult | null> {
      const sourceSystem = input.sourceSystem?.trim().toLowerCase()
      if (!input.workspaceId?.trim()) throw new DomainIdentityError('entity resolution requires a workspaceId')
      if (!sourceSystem) throw new DomainIdentityError('entity resolution requires a sourceSystem')

      if (tenantCheck !== 'never') {
        const connection = await getDomainSourceConnection(input.workspaceId, sourceSystem)
        if (!connection) {
          if (tenantCheck === 'always') {
            throw new DomainIdentityError(
              `workspace ${input.workspaceId} has no active ${sourceSystem} connection`
            )
          }
        } else if (
          input.sourceCompanyId?.trim() &&
          connection.externalTenantId !== input.sourceCompanyId.trim()
        ) {
          // A change that arrived tagged with a tenant this workspace is not
          // bound to is a routing bug or a leak. Failing loudly beats filing it
          // under the wrong business.
          throw new DomainIdentityError(
            `${sourceSystem} tenant mismatch for workspace ${input.workspaceId}`
          )
        }
      }

      const entity = await resolveDomainEntity({
        workspaceId: input.workspaceId,
        domain,
        entityType: entityTypeFor(input.sourceEntityType),
        authority: 'external_authoritative',
        sourceSystem,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
        displayName: input.displayName ?? null,
      })

      return { entityId: entity.id, entityType: entity.entityType }
    },
  }
}
