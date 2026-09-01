import 'server-only'
import { createServiceClient } from './supabase-server'
import {
  claimDueOperations,
  markSynced,
  markAttemptFailed,
  type PendingOperationRow,
} from './pending-operations'
import { syncBookingToCalendar } from './calendar-sync'
import { classifyError } from './caye-agent/tools/result'
import { alertFounderOfDeliveryFailure } from './whatsapp/founder-alert'
import { runOutreachSourcingJob } from './outreach-sourcing-job'
import { recordCronRun } from './cron-run-log'
import { processArtifact } from './artifacts/process'
import { runRecommendationActionOperation } from './recommendations/action-operation'
import { createProductionRecommendationActionRuntime } from './recommendations/action-runtime-production'
import { validateRecommendationActionPlan } from './recommendations/action-plan'
import { recordExecutedRecommendationAction } from './recommendations/observations'

/**
 * Drains caye_pending_operations — the durable outbox for external effects
 * whose first attempt failed transiently.
 *
 * Lives in lib/ rather than in the route because it is called from two
 * places: its own endpoint (/api/caye/operation-worker, for manual and
 * admin-shell triggering) and opportunistically from the outbound worker,
 * which already ticks about once a minute.
 */

const BATCH_LIMIT = 25

export interface DrainSummary extends Record<string, unknown> {
  scanned: number
  synced: number
  retrying: number
  dead_letter: number
}

export async function drainPendingOperations(limit = BATCH_LIMIT): Promise<DrainSummary> {
  const rows = await claimDueOperations(limit)
  const counts: DrainSummary = { scanned: rows.length, synced: 0, retrying: 0, dead_letter: 0 }
  for (const row of rows) {
    const outcome = await processOperation(row)
    counts[outcome] += 1
  }
  return counts
}

/** Never throws — same contract as the other opportunistic checks. */
export async function drainPendingOperationsSafely(limit = BATCH_LIMIT): Promise<void> {
  try {
    const summary = await drainPendingOperations(limit)
    if (summary.scanned > 0) {
      console.log(`[pending-operations] drained: ${summary.synced} synced, ${summary.retrying} retrying, ${summary.dead_letter} dead-lettered`)
    }
  } catch (err) {
    console.error('[pending-operations] drain failed:', err)
  }
}

type Outcome = 'synced' | 'retrying' | 'dead_letter'

function payloadString(row: PendingOperationRow, key: string): string | null {
  const value = row.payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * #378 integration. The operation row is already durably `synced` when this is
 * called, so the evidence source is the canonical existing execution/outbox
 * record rather than a model assertion or a second recommendation ledger.
 */
async function recordRecommendationExecutionOutcome(row: PendingOperationRow, executionRef?: string | null): Promise<void> {
  const recommendationId = payloadString(row, 'recommendation_id')
  const recommendationVersion = payloadString(row, 'recommendation_version')
  const decisionId = payloadString(row, 'decision_id')
  if (!recommendationId || !recommendationVersion || !decisionId) return

  const db = createServiceClient()
  const [{ data: recommendation, error: recommendationError }, { data: decision, error: decisionError }] = await Promise.all([
    db.from('caye_recommendations')
      .select('id,workspace_id,provenance')
      .eq('id', recommendationId)
      .eq('workspace_id', row.workspace_id)
      .maybeSingle(),
    db.from('caye_recommendation_decisions')
      .select('id,recommendation_id,recommendation_version,actor_kind,authority_provenance')
      .eq('id', decisionId)
      .eq('recommendation_id', recommendationId)
      .maybeSingle(),
  ])
  if (recommendationError || decisionError) throw recommendationError ?? decisionError
  if (!recommendation || !decision || decision.recommendation_version !== recommendationVersion) return

  const provenance = recommendation.provenance && typeof recommendation.provenance === 'object' && !Array.isArray(recommendation.provenance)
    ? recommendation.provenance as Record<string, unknown>
    : {}
  const plan = validateRecommendationActionPlan(provenance.actionPlan)

  await recordExecutedRecommendationAction({
    recommendationId,
    decisionId,
    workspaceId: row.workspace_id,
    executionKey: row.idempotency_key,
    executionSourceTable: 'caye_pending_operations',
    executionSourceId: row.id,
    executionProvenance: {
      recommendationVersion,
      capabilityKey: plan.capabilityKey,
      operation: plan.operation,
      decisionActorKind: decision.actor_kind,
      authorityProvenance: decision.authority_provenance ?? {},
      executionRef: executionRef ?? `caye_pending_operations:${row.id}`,
    },
    observationPlan: {
      kind: 'unknown',
      expectedEffect: {
        description: plan.expectedEffect,
        capabilityKey: plan.capabilityKey,
        operation: plan.operation,
      },
    },
  })
}

async function processOperation(row: PendingOperationRow): Promise<Outcome> {
  try {
    switch (row.operation) {
      case 'recommendation_action': {
        const result = await runRecommendationActionOperation(row, createProductionRecommendationActionRuntime())
        if (result.disposition === 'synced') {
          await markSynced(row)
          if (result.reason === 'completed') {
            await recordRecommendationExecutionOutcome(row, result.executionRef).catch((error) => {
              // Never replay a successfully executed capability just because
              // downstream outcome observation had a transient problem.
              console.error('[recommendation-action] outcome handoff failed:', error)
            })
          }
          return 'synced'
        }
        return await fail(row, result.error, result.disposition === 'retry')
      }

      case 'outreach_sourcing': {
        await recordCronRun('outreach-sourcing-scan', async () => runOutreachSourcingJob(row.workspace_id))
        await markSynced(row)
        return 'synced'
      }
      case 'artifact_process': {
        const artifactId = typeof row.payload.artifact_id === 'string' ? row.payload.artifact_id : null
        if (!artifactId) return await fail(row, 'operation payload has no artifact_id', false)
        const result = await processArtifact(artifactId)
        if (result.ok) {
          await markSynced(row)
          return 'synced'
        }
        return await fail(row, result.error, true)
      }

      case 'zoho_calendar_upsert':
      case 'zoho_calendar_delete': {
        const bookingId = typeof row.payload.booking_id === 'string' ? row.payload.booking_id : null
        if (!bookingId) return await fail(row, 'operation payload has no booking_id', false)
        const supabase = createServiceClient()
        const { data: booking } = await supabase.from('bookings').select('id').eq('id', bookingId).maybeSingle()
        if (!booking) {
          await markSynced(row)
          return 'synced'
        }
        const action = row.operation === 'zoho_calendar_delete' ? 'delete' : 'upsert'
        const result = await syncBookingToCalendar(row.workspace_id, bookingId, action)
        if (result.synced) {
          await markSynced(row)
          return 'synced'
        }
        if (result.deferred) return await fail(row, result.reason, true)
        return await fail(row, result.reason, false)
      }

      default:
        return await fail(row, `unknown operation kind: ${row.operation}`, true)
    }
  } catch (err) {
    const classified = classifyError(err, 'OPERATION_WORKER_THREW')
    const msg = err instanceof Error ? err.message : String(err)
    return await fail(row, msg, classified.status === 'FAILED_RETRYABLE')
  }
}

async function fail(row: PendingOperationRow, error: string, retryable: boolean): Promise<Outcome> {
  const outcome = await markAttemptFailed(row, error, { retryable })
  if (outcome === 'dead_letter') {
    console.error(`[pending-operations] dead-lettered ${row.operation} for workspace ${row.workspace_id} after ${row.attempts + 1} attempts: ${error}`)
    // Recommendation failures use the canonical owner-attention ledger inside
    // their execution runtime. Do not turn every dead letter into a new
    // WhatsApp notification and duplicate Direction's Needs You surface.
    if (row.operation !== 'recommendation_action') {
      await alertFounderOfDeliveryFailure({
        workspaceId: row.workspace_id,
        kind: row.operation,
        detail: error,
        stage: 'dispatch',
      }).catch((err) => console.error('[pending-operations] founder alert failed:', err))
    }
    return 'dead_letter'
  }
  return 'retrying'
}
