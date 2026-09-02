import 'server-only'

import {
  createDomainConnectionResolver,
  type DomainConnectionResolver,
  type DomainSourceConnection,
} from '@/lib/domain/connections'
import { requireConnectionConfigString, resolveDomainSecret } from '@/lib/domain/secrets'
import { BEDROCK_SOURCE_SYSTEM, type BedrockConnection, type BedrockConnectionResolver } from './types'

/**
 * The Bedrock adapter's connection resolver, backed by the generic kernel
 * table instead of `BEDROCK_CONNECTIONS_JSON`.
 *
 * The adapter is untouched: it still receives a `BedrockConnection` from
 * something satisfying `BedrockConnectionResolver`. What changes is where the
 * tenant binding comes from — `domain_source_connections` rather than a blob
 * of JSON in the environment that nobody can audit per-workspace.
 *
 * Three things are kept apart on purpose:
 *   - `external_tenant_id` is the Bedrock company id. It is the tenant binding
 *     and it is NOT part of Caye entity identity.
 *   - `config.supabase_url` is non-secret connection configuration.
 *   - `credential_ref` names a secret; the value is materialised here, at the
 *     moment a client is built, and never stored on the row.
 *
 * Fail-closed throughout: a missing row returns null (the adapter raises
 * `BedrockConnectionMissingError`), and a row that is present but unusable
 * throws rather than degrading into an unscoped or wrongly-scoped client.
 */
export class KernelBedrockConnectionResolver implements BedrockConnectionResolver {
  readonly #connections: DomainConnectionResolver
  readonly #env: NodeJS.ProcessEnv

  constructor(
    connections: DomainConnectionResolver = createDomainConnectionResolver(BEDROCK_SOURCE_SYSTEM),
    env: NodeJS.ProcessEnv = process.env
  ) {
    this.#connections = connections
    this.#env = env
  }

  async resolve(workspaceId: string): Promise<BedrockConnection | null> {
    if (!workspaceId?.trim()) return null

    const connection = await this.#connections.resolve(workspaceId)
    // `getDomainSourceConnection` already withholds paused/revoked rows; this
    // is belt-and-braces for a custom resolver that might not.
    if (!connection || connection.status !== 'active') return null

    return toBedrockConnection(connection, this.#env)
  }
}

/**
 * Projects a generic kernel connection onto the shape the Bedrock adapter
 * wants. Exported so the change-source runtime can build a client from a
 * connection it already loaded, without a second database round trip.
 */
export function toBedrockConnection(
  connection: DomainSourceConnection,
  env: NodeJS.ProcessEnv = process.env
): BedrockConnection {
  if (connection.sourceSystem !== BEDROCK_SOURCE_SYSTEM) {
    throw new Error(
      `expected a ${BEDROCK_SOURCE_SYSTEM} connection, got ${connection.sourceSystem}`
    )
  }
  const companyId = connection.externalTenantId?.trim()
  if (!companyId) {
    throw new Error(`${BEDROCK_SOURCE_SYSTEM} connection has no external_tenant_id (company id)`)
  }

  return {
    workspaceId: connection.workspaceId,
    companyId,
    supabaseUrl: requireConnectionConfigString(connection.config, 'supabase_url', BEDROCK_SOURCE_SYSTEM),
    serviceRoleKey: resolveDomainSecret(connection.credentialRef, env),
  }
}
