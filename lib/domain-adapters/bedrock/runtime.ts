import 'server-only'

import { getDomainSourceConnection } from '@/lib/domain/connections'
import { createKernelEntityResolver } from '@/lib/domain/resolver'
import { SupabaseDomainCheckpointStore, withPendingObservationFlush } from '@/lib/domain-events/checkpoints'
import { runDomainEventBridge, type RunDomainBridgeResult } from '@/lib/domain-events/bridge'
import type { DomainChangeSource } from '@/lib/domain-events/types'
import { SupabaseDomainEventSink } from '@/lib/domain-events/sink'
import { BedrockAdapter } from './adapter'
import { BedrockPurchaseOrderChangeSource } from './change-source'
import { BedrockProjectChangeSource } from './project-change-source'
import { BedrockEstimateChangeSource } from './estimate-change-source'
import { BedrockReceiptChangeSource } from './receipt-change-source'
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
 *        -> one change source per stream (purchase orders, projects,
 *           estimates, receipts)
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
 * The change streams Bedrock exposes, and how to build each one.
 *
 * A registry rather than four near-identical functions, because every stream
 * shares the same bridge wiring and only differs in which source it polls.
 * `domain_sync_cursors` is keyed by stream, so each advances its own
 * checkpoint independently and one stalling cannot hold the others back.
 */
type ChangeSourceFactory = (args: {
  workspaceId: string
  companyId: string
  provider: SupabaseBedrockReadProvider
  snapshots: SupabaseDomainSnapshotStore
  batchSize?: number
}) => BedrockChangeSource

/**
 * `withPendingObservationFlush` needs the source to flush observations it
 * staged but has not yet checkpointed, so the registry's contract is a change
 * source that can also do that — not the bare `DomainChangeSource`.
 */
type BedrockChangeSource = DomainChangeSource & { flushPending(): Promise<void> }

export const BEDROCK_CHANGE_STREAMS: Record<string, ChangeSourceFactory> = {
  purchase_orders: (args) => new BedrockPurchaseOrderChangeSource(args),
  projects: (args) => new BedrockProjectChangeSource(args),
  estimates: (args) => new BedrockEstimateChangeSource(args),
  receipts: (args) => new BedrockReceiptChangeSource(args),
}

export type BedrockStreamOutcome =
  | { stream: string; ok: true; result: RunDomainBridgeResult }
  | { stream: string; ok: false; error: string }

/**
 * Polls every Bedrock change stream for one workspace and projects the
 * meaningful changes into `workspace_events`.
 *
 * Read-only against Bedrock throughout. Nothing on this path can write to the
 * source system: the provider exposes no mutation, and the adapter implements
 * `DomainReadAdapter` semantics only.
 *
 * One stream's failure does not stop the others. Estimates being unreadable is
 * not a reason to stop hearing that material landed — and each stream owns its
 * own checkpoint, so a failed one simply resumes where it was next time.
 */
export async function runBedrockSync(
  options: BedrockSyncOptions & { streams?: string[] }
): Promise<BedrockStreamOutcome[]> {
  const { workspaceId } = options

  const connection = await getDomainSourceConnection(workspaceId, BEDROCK_SOURCE_SYSTEM)
  if (!connection) throw new BedrockConnectionMissingError(workspaceId)

  const bedrock = toBedrockConnection(connection)
  const provider = new SupabaseBedrockReadProvider(bedrock)
  const snapshots = new SupabaseDomainSnapshotStore()

  const names = options.streams ?? Object.keys(BEDROCK_CHANGE_STREAMS)
  const outcomes: BedrockStreamOutcome[] = []

  for (const stream of names) {
    const make = BEDROCK_CHANGE_STREAMS[stream]
    if (!make) {
      outcomes.push({ stream, ok: false, error: `unknown Bedrock change stream: ${stream}` })
      continue
    }

    try {
      const source = make({
        workspaceId,
        companyId: bedrock.companyId,
        provider,
        snapshots,
        batchSize: options.batchSize,
      })

      const result = await runDomainEventBridge({
        workspaceId,
        sourceSystem: BEDROCK_SOURCE_SYSTEM,
        sourceCompanyId: bedrock.companyId,
        source,
        resolver: createBedrockEntityResolver(),
        sink: new SupabaseDomainEventSink(),
        checkpoints: withPendingObservationFlush(new SupabaseDomainCheckpointStore(), source),
        maxBatches: options.maxBatches,
      })
      outcomes.push({ stream, ok: true, result })
    } catch (error) {
      outcomes.push({
        stream,
        ok: false,
        error: error instanceof Error ? error.message : 'unknown error',
      })
    }
  }

  return outcomes
}

/**
 * The original single-stream entry point, kept because it is the narrowest
 * thing a caller can ask for and the e2e fixture reasons about one stream.
 */
export async function runBedrockPurchaseOrderSync(
  options: BedrockSyncOptions
): Promise<RunDomainBridgeResult> {
  const [outcome] = await runBedrockSync({ ...options, streams: ['purchase_orders'] })
  if (!outcome.ok) throw new Error(outcome.error)
  return outcome.result
}

/**
 * The read adapter, bound to the kernel connection table. This is how Caye
 * answers "what is this purchase order NOW" after an event has been projected
 * — the authoritative answer comes from Bedrock, never from business_entities.
 */
export function createBedrockAdapter(): BedrockAdapter {
  return new BedrockAdapter(new KernelBedrockConnectionResolver())
}
