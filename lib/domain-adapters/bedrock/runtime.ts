import 'server-only'

import { getDomainSourceConnection } from '@/lib/domain/connections'
import { createKernelEntityResolver } from '@/lib/domain/resolver'
import { SupabaseDomainCheckpointStore, withPendingObservationFlush } from '@/lib/domain-events/checkpoints'
import { runDomainEventBridge, type RunDomainBridgeResult } from '@/lib/domain-events/bridge'
import { SupabaseDomainEventSink } from '@/lib/domain-events/sink'
import { BedrockAdapter } from './adapter'
import { BedrockPurchaseOrderChangeSource } from './change-source'
import { KernelBedrockConnectionResolver, toBedrockConnection } from './kernel-connection'
import { SupabaseBedrockReadProvider } from './provider'
import { SupabaseDomainSnapshotStore } from './supabase-snapshot-store'
import { BEDROCK_SOURCE_SYSTEM, BedrockConnectionMissingError } from './types'

/**
 * The assembled Bedrock -> Caye path, in one place.
 *
 *   domain_source_connections
 *        -> BedrockConnectionResolver   (which company, which credentials)
 *        -> BedrockReadProvider         (company-scoped reads only)
 *        -> BedrockPurchaseOrderChangeSource
 *        -> runDomainEventBridge        (normalisation, tenant guard)
 *        -> kernel entity resolver      (canonical business_entities.id)
 *        -> ingest_external_domain_event
 *        -> workspace_events            (existing continuous perception)
 *
 * Caye's construction domain is bound here, at the wiring, because the source
 * system has no opinion about Caye's taxonomy and the kernel refuses to guess
 * one.
 */

export const BEDROCK_DOMAIN = 'construction'

/**
 * The kernel resolver for Bedrock identities.
 *
 * `tenantCheck: 'always'` rather than the kernel's 'when_bound' default: this
 * runtime only ever runs for a workspace that already has a connection row, so
 * a missing one means the binding was removed mid-run. Registering entities
 * against a workspace that is no longer authorised to read Bedrock would be
 * the wrong way to fail.
 */
export function createBedrockEntityResolver() {
  return createKernelEntityResolver({ domain: BEDROCK_DOMAIN, tenantCheck: 'always' })
}

export interface BedrockSyncOptions {
  workspaceId: string
  batchSize?: number
  maxBatches?: number
}

/**
 * Polls one workspace's Bedrock purchase orders and projects the meaningful
 * changes into `workspace_events`.
 *
 * Read-only against Bedrock throughout. Nothing on this path can write to the
 * source system: the provider exposes no mutation, and the adapter implements
 * `DomainReadAdapter` semantics only.
 */
export async function runBedrockPurchaseOrderSync(
  options: BedrockSyncOptions
): Promise<RunDomainBridgeResult> {
  const { workspaceId } = options

  const connection = await getDomainSourceConnection(workspaceId, BEDROCK_SOURCE_SYSTEM)
  if (!connection) throw new BedrockConnectionMissingError(workspaceId)

  const bedrock = toBedrockConnection(connection)
  const provider = new SupabaseBedrockReadProvider(bedrock)

  const source = new BedrockPurchaseOrderChangeSource({
    workspaceId,
    companyId: bedrock.companyId,
    provider,
    snapshots: new SupabaseDomainSnapshotStore(),
    batchSize: options.batchSize,
  })

  return runDomainEventBridge({
    workspaceId,
    sourceSystem: BEDROCK_SOURCE_SYSTEM,
    sourceCompanyId: bedrock.companyId,
    source,
    resolver: createBedrockEntityResolver(),
    sink: new SupabaseDomainEventSink(),
    checkpoints: withPendingObservationFlush(new SupabaseDomainCheckpointStore(), source),
    maxBatches: options.maxBatches,
  })
}

/**
 * The read adapter, bound to the kernel connection table. This is how Caye
 * answers "what is this purchase order NOW" after an event has been projected
 * — the authoritative answer comes from Bedrock, never from business_entities.
 */
export function createBedrockAdapter(): BedrockAdapter {
  return new BedrockAdapter(new KernelBedrockConnectionResolver())
}
