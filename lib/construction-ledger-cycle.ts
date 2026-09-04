import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { projectDomainEventsToAttention, type DomainAttentionResult } from '@/lib/domain-attention'
import { raiseReceivablesAttention, type ReceivablesAttentionResult } from '@/lib/receivables-attention'
import { projectFreightRequestsToAttention, type FreightAttentionResult } from '@/lib/freight-attention'
import { runBedrockSync, type BedrockStreamOutcome } from '@/lib/domain-adapters/bedrock'
import {
  deliverConstructionAttention,
  type ConstructionAttentionDeliveryResult,
} from '@/lib/construction-attention-delivery'

/**
 * One pass of the construction ledger loop, for every workspace bound to one.
 *
 *   poll the source  ->  project changes into workspace_events  ->  raise attention
 *                                                                 -> raise receivables attention
 *
 * ORDER MATTERS, AND SO DOES THE FAILURE SHAPE
 *
 * Attention can only surface what the sync has already ingested, so the sync
 * runs first. But the projection runs *even when the sync fails*: a source
 * outage must not also withhold changes that were ingested on an earlier pass
 * and have not yet reached anyone. Delivery is not allowed to depend on the
 * freshest poll succeeding — that coupling is exactly how correct detection
 * ends up undelivered. The receivables sweep is a third, independent step for
 * the same reason: a domain-event projection failure must not also withhold
 * the Friday ask, and vice versa.
 *
 * Both the sync/projection halves are idempotent. The bridge dedupes on a
 * source idempotency key and refuses stale events via a monotonic watermark;
 * the attention ledger keys on (workspace, subject_type, subject_id) and
 * suppresses an unchanged fingerprint. So an overlapping window is safe and a
 * missed one is not, which is why this leans on overlap rather than on a
 * tight cursor.
 *
 * The receivables sweep is idempotent for the same ledger reason (see
 * `raiseReceivablesAttention`'s header), which is also why it needs no window
 * or cursor at all: it re-reads the invoices' current state on every pass and
 * only the ledger's fingerprint decides whether that state is news. Running
 * it on this cycle's 30-minute cadence is what keeps the weekly "Friday ask"
 * honest without a schedule table — it is a property of what changes, not a
 * timer.
 */

/** Deliberate overlap. Cheap because both halves are idempotent. */
const DEFAULT_ATTENTION_WINDOW_MS = 2 * 60 * 60 * 1000

export interface ConstructionLedgerWorkspaceResult {
  workspaceId: string
  sync: BedrockStreamOutcome[] | null
  syncError: string | null
  attention: DomainAttentionResult | null
  attentionError: string | null
  receivables: ReceivablesAttentionResult | null
  receivablesError: string | null
  freightAttention: FreightAttentionResult | null
  freightAttentionError: string | null
  delivery: ConstructionAttentionDeliveryResult | null
  deliveryError: string | null
}

export interface ConstructionLedgerCycleResult {
  workspaces: number
  results: ConstructionLedgerWorkspaceResult[]
}

export interface ConstructionLedgerCycleDeps {
  listBoundWorkspaces: () => Promise<string[]>
  sync: typeof runBedrockSync
  project: typeof projectDomainEventsToAttention
  raiseReceivables: typeof raiseReceivablesAttention
  projectFreight: typeof projectFreightRequestsToAttention
  deliver: typeof deliverConstructionAttention
}

const BEDROCK = 'bedrock'

/**
 * The connection table is the driver rather than a separate feature flag.
 * A workspace has a construction ledger exactly when it is bound to one, and
 * a paused or revoked binding is a deliberate instruction to stop polling.
 */
async function listBoundWorkspacesFromDb(): Promise<string[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('domain_source_connections')
    .select('workspace_id')
    .eq('source_system', BEDROCK)
    .eq('status', 'active')

  if (error) throw new Error(`could not list construction ledger connections — ${error.message}`)
  return (data ?? []).map((row) => row.workspace_id as string)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

export async function runConstructionLedgerCycle(args: {
  attentionWindowMs?: number
  maxBatches?: number
  deps?: Partial<ConstructionLedgerCycleDeps>
} = {}): Promise<ConstructionLedgerCycleResult> {
  const listBoundWorkspaces = args.deps?.listBoundWorkspaces ?? listBoundWorkspacesFromDb
  const sync = args.deps?.sync ?? runBedrockSync
  const project = args.deps?.project ?? projectDomainEventsToAttention
  const raiseReceivables = args.deps?.raiseReceivables ?? raiseReceivablesAttention
  const projectFreight = args.deps?.projectFreight ?? projectFreightRequestsToAttention
  const deliver = args.deps?.deliver ?? deliverConstructionAttention
  const windowMs = args.attentionWindowMs ?? DEFAULT_ATTENTION_WINDOW_MS

  const workspaceIds = await listBoundWorkspaces()
  const results: ConstructionLedgerWorkspaceResult[] = []

  // Sequential on purpose. These calls fan out to a customer's own database,
  // and one tick of a background cron is not worth putting concurrent read
  // load on the system a crew is trying to work in.
  for (const workspaceId of workspaceIds) {
    const result: ConstructionLedgerWorkspaceResult = {
      workspaceId,
      sync: null,
      syncError: null,
      attention: null,
      attentionError: null,
      receivables: null,
      receivablesError: null,
      freightAttention: null,
      freightAttentionError: null,
      delivery: null,
      deliveryError: null,
    }

    try {
      result.sync = await sync({ workspaceId, maxBatches: args.maxBatches })
    } catch (error) {
      result.syncError = message(error)
    }

    try {
      result.attention = await project({
        workspaceId,
        since: new Date(Date.now() - windowMs),
      })
    } catch (error) {
      result.attentionError = message(error)
    }

    // Independent of both steps above — see the header on why a failure here
    // must not withhold what the domain-event projection already produced,
    // and vice versa.
    try {
      result.receivables = await raiseReceivables({ workspaceId })
    } catch (error) {
      result.receivablesError = message(error)
    }

    // A fourth independent step, same shape as the three above: freight
    // requests are detected by the Gmail poll cron, not by this sync, so
    // this does not depend on `sync` having succeeded this pass — it reads
    // whatever `unified_conversations.metadata.freight_workflow` already
    // holds. One workspace's (or one producer's) failure here must not
    // withhold what sync/attention already produced above, so this gets its
    // own try/catch rather than sharing the block above.
    try {
      result.freightAttention = await projectFreight({ workspaceId })
    } catch (error) {
      result.freightAttentionError = message(error)
    }

    // THE LAST HOP, and the reason the rest of this loop was worth building.
    //
    // Everything above raises attention. Until this step existed, nothing
    // delivered it: the receivables sweep computed the entire weekly ask and
    // left it in a table, which is the ODS audit's own finding — correct work
    // with the last step missed — reproduced in the software written to fix
    // it.
    //
    // Runs LAST because it reads what the steps above just wrote, but it is
    // independent of all of them for the usual reason, and one that matters
    // more here than anywhere else in this function: a sync outage must not
    // also withhold an invoice that was already detected on an earlier pass
    // and has still never reached a human. Delivery is not allowed to depend
    // on the freshest poll succeeding.
    //
    // It sends nothing on its own authority. Quiet hours, the workspace's
    // notifications_paused gate inside enqueueOutbound, and routing's refusal
    // to hand anything to an unmapped or unverified operator all still apply.
    try {
      result.delivery = await deliver({ workspaceId })
    } catch (error) {
      result.deliveryError = message(error)
    }

    // One workspace's outage is not another's. A thrown error here would stop
    // every workspace after this one in the list.
    results.push(result)
  }

  return { workspaces: workspaceIds.length, results }
}
