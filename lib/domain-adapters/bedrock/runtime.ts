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
import { BedrockPayPeriodChangeSource } from './pay-period-change-source'
import { KernelBedrockConnectionResolver, toBedrockConnection } from './kernel-connection'
import { SupabaseBedrockReadProvider } from './provider'
import { SupabaseDomainSnapshotStore } from './supabase-snapshot-store'
import { BedrockWriteProvider } from './write-provider'
import { BEDROCK_SOURCE_SYSTEM, BedrockConnectionMissingError } from './types'

/**
 * The assembled Bedrock -> Caye path, in one place.
 *
 *   domain_source_connections
 *        -> BedrockConnectionResolver   (which company, which credentials)
 *        -> BedrockReadProvider         (company-scoped reads only)
 *        -> one change source per stream (purchase orders, projects,
 *           estimates, receipts, pay periods)
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
  pay_periods: (args) => new BedrockPayPeriodChangeSource(args),
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

/**
 * The write boundary, resolved for one workspace.
 *
 * Deliberately a separate factory from `createBedrockAdapter`, and deliberately
 * not memoised into a shared singleton: obtaining write access should be an
 * explicit act at the call site, visible in a diff, rather than something a
 * caller acquires by holding the read adapter it already had.
 *
 * Throws when the workspace has no active Bedrock binding, so a workspace that
 * was never connected — or whose binding was paused or revoked — cannot be
 * written to on the strength of a stale reference.
 */
export async function createBedrockWriteProvider(
  workspaceId: string
): Promise<{
  provider: BedrockWriteProvider
  companyId: string
  identityFor: (operatorId: number | string | null | undefined) => BedrockOperatorIdentity
}> {
  const connection = await getDomainSourceConnection(workspaceId, BEDROCK_SOURCE_SYSTEM)
  if (!connection) throw new BedrockConnectionMissingError(workspaceId)

  const bedrock = toBedrockConnection(connection)
  return {
    provider: new BedrockWriteProvider(bedrock),
    companyId: bedrock.companyId,
    identityFor: (operatorId) => bedrockIdentityFor(connection.config, operatorId),
  }
}

/** How a Caye operator appears inside the construction ledger. */
export interface BedrockOperatorIdentity {
  /** `profiles.id` — who a written row is attributed to. */
  profileId: string | null
  /** `workers.id` — whose hours "me" means. Null for anyone not on the hourly roster. */
  workerId: string | null
}

/**
 * Read the operator's ledger identities from the binding's non-secret config.
 *
 * TWO MAPPINGS, NOT ONE, BECAUSE THEY ARE TWO DIFFERENT THINGS
 *
 * `profiles` and `workers` are separate tables holding separate people. Wallace,
 * Omar and Jay exist as profiles and appear in NO worker row; the hourly crew
 * exist as workers and have no profile. So:
 *
 *   - `operator_profiles` answers "who recorded this" -> time_entries.created_by
 *   - `operator_workers`  answers "whose hours are these" -> "me" in a crew day
 *
 * A supervisor reporting a crew day is the author of the record without being
 * one of the people on it. Collapsing these into one mapping would either
 * refuse a legitimate report or invent an hourly row for someone who is not
 * paid hourly.
 *
 * Both return null when unmapped, and that is the point: an unattributable
 * write into a table that feeds payroll must be refused, never defaulted.
 */
export function bedrockIdentityFor(
  config: Record<string, unknown> | null | undefined,
  operatorId: number | string | null | undefined
): BedrockOperatorIdentity {
  return {
    profileId: lookupOperator(config, 'operator_profiles', operatorId),
    workerId: lookupOperator(config, 'operator_workers', operatorId),
  }
}

function lookupOperator(
  config: Record<string, unknown> | null | undefined,
  key: string,
  operatorId: number | string | null | undefined
): string | null {
  if (operatorId === null || operatorId === undefined) return null
  const map = (config ?? {})[key]
  if (!map || typeof map !== 'object') return null
  const value = (map as Record<string, unknown>)[String(operatorId)]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Read-side access to the same mapping, for tools that resolve before writing. */
export async function getBedrockOperatorIdentity(
  workspaceId: string,
  operatorId: number | string | null | undefined
): Promise<BedrockOperatorIdentity> {
  const connection = await getDomainSourceConnection(workspaceId, BEDROCK_SOURCE_SYSTEM)
  if (!connection) throw new BedrockConnectionMissingError(workspaceId)
  return bedrockIdentityFor(connection.config, operatorId)
}
