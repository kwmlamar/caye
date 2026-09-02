import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { DomainIdentityError } from './authority'

/**
 * Workspace to external-tenant binding.
 *
 * This is the only place a source system's company/tenant identifier belongs.
 * Entity identity is deliberately free of it, so rotating credentials or
 * re-pointing a connection cannot change what a business entity IS. A Bedrock
 * project keeps its canonical Caye uuid across a credential rotation, a
 * connection pause, and a change of connection implementation.
 *
 * Secrets are not stored. `credentialRef` names a secret in the server-side
 * secret store; materialising it is the caller's job, so this module never
 * holds a key even transiently.
 */

export const DOMAIN_SOURCE_CONNECTIONS_TABLE = 'domain_source_connections'

export type DomainSourceConnectionStatus = 'active' | 'paused' | 'revoked'

export interface DomainSourceConnection {
  id: string
  workspaceId: string
  sourceSystem: string
  /** The tenant/company identifier inside the source system. */
  externalTenantId: string
  status: DomainSourceConnectionStatus
  /** A secret NAME, never a secret value. */
  credentialRef: string | null
  /** Non-secret connection configuration (region, base url, feature flags). */
  config: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

type DomainSourceConnectionRow = {
  id: string
  workspace_id: string
  source_system: string
  external_tenant_id: string
  status: DomainSourceConnectionStatus
  credential_ref: string | null
  config: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

function toDomainSourceConnection(row: DomainSourceConnectionRow): DomainSourceConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceSystem: row.source_system,
    externalTenantId: row.external_tenant_id,
    status: row.status,
    credentialRef: row.credential_ref,
    config: row.config ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * The seam a domain adapter's connection resolver should sit on. Bedrock's
 * transitional env-backed resolver satisfies the same shape, so swapping it
 * for this one is a constructor change rather than an adapter rewrite.
 */
export interface DomainConnectionResolver {
  resolve(workspaceId: string): Promise<DomainSourceConnection | null>
}

/**
 * Returns the active connection for a workspace and source system, or null.
 * Paused and revoked connections are withheld: an adapter must not keep
 * reading a source the workspace has stopped authorising.
 */
export async function getDomainSourceConnection(
  workspaceId: string,
  sourceSystem: string
): Promise<DomainSourceConnection | null> {
  if (!workspaceId?.trim()) throw new DomainIdentityError('getDomainSourceConnection requires a workspaceId')
  if (!sourceSystem?.trim()) throw new DomainIdentityError('getDomainSourceConnection requires a sourceSystem')

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from(DOMAIN_SOURCE_CONNECTIONS_TABLE)
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('source_system', sourceSystem.trim().toLowerCase())
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw new Error(`domain source connection read failed: ${error.message}`)
  return data ? toDomainSourceConnection(data as DomainSourceConnectionRow) : null
}

/** All workspaces currently bound to a source system, for scheduled sweeps. */
export async function listDomainSourceConnections(
  sourceSystem: string
): Promise<DomainSourceConnection[]> {
  if (!sourceSystem?.trim()) throw new DomainIdentityError('listDomainSourceConnections requires a sourceSystem')

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from(DOMAIN_SOURCE_CONNECTIONS_TABLE)
    .select('*')
    .eq('source_system', sourceSystem.trim().toLowerCase())
    .eq('status', 'active')
    .order('created_at', { ascending: true })

  if (error) throw new Error(`domain source connection listing failed: ${error.message}`)
  return (data ?? []).map((row) => toDomainSourceConnection(row as DomainSourceConnectionRow))
}

/**
 * Adapter-facing resolver bound to one source system.
 *
 * Deliberately returns the connection only, never credentials. The integration
 * pass materialises `credentialRef` against its own secret store and builds
 * whatever client the adapter needs.
 */
export function createDomainConnectionResolver(sourceSystem: string): DomainConnectionResolver {
  return {
    resolve: (workspaceId: string) => getDomainSourceConnection(workspaceId, sourceSystem),
  }
}
