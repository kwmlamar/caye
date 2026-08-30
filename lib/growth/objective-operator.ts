import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { recordObjectiveDirectionEvidence } from '@/lib/operator/direction-evidence'
import { runBoundedObjective } from '@/lib/operator/objective-run'
import { finalizeObjectiveRun, openOrResumeObjectiveRun, persistObjectiveEvent } from '@/lib/operator/objective-store'
import { runGrowthIngestion } from './ingest'

const OBJECTIVE_KEY = 'growth_closed_loop_v1'
const PLAN_VERSION = '1'
const MAX_TRANSITIONS = 6
const TIMEOUT_MS = 45_000
const MAX_RUN_AGE_MS = 15 * 60_000

type GrowthSourceState = {
  id: string
  provider: string
  status: string
  last_success_at: string | null
  last_error_at: string | null
  last_error_code: string | null
}

type GrowthObservation = {
  id: string
  source_id: string
  metric_key: string
  metric_value: number | string | null
  metric_unit: string | null
  observed_at: string
}

type EvidenceSnapshot = {
  sources: GrowthSourceState[]
  observations: GrowthObservation[]
  evidenceReady: boolean
  blockers: string[]
}

export function summarizeGrowthEvidence(input: {
  sources: GrowthSourceState[]
  observations: GrowthObservation[]
}): EvidenceSnapshot {
  const connected = input.sources.filter((source) => source.status === 'connected')
  const blockers: string[] = []

  if (input.sources.length === 0) blockers.push('no_growth_sources_configured')
  if (connected.length === 0) blockers.push('no_growth_sources_connected')
  if (input.observations.length === 0) blockers.push('no_growth_observations')

  return {
    ...input,
    evidenceReady: connected.length > 0 && input.observations.length > 0,
    blockers,
  }
}

async function readEvidenceSnapshot(workspaceId: string): Promise<EvidenceSnapshot> {
  const supabase = createServiceClient()
  const [sources, observations] = await Promise.all([
    supabase
      .from('growth_sources')
      .select('id,provider,status,last_success_at,last_error_at,last_error_code')
      .eq('workspace_id', workspaceId)
      .order('provider'),
    supabase
      .from('growth_observations')
      .select('id,source_id,metric_key,metric_value,metric_unit,observed_at')
      .eq('workspace_id', workspaceId)
      .order('observed_at', { ascending: false })
      .limit(100),
  ])

  if (sources.error) throw new Error(`growth_sources_unavailable:${sources.error.message}`)
  if (observations.error) throw new Error(`growth_observations_unavailable:${observations.error.message}`)

  return summarizeGrowthEvidence({
    sources: (sources.data ?? []) as GrowthSourceState[],
    observations: (observations.data ?? []) as GrowthObservation[],
  })
}

/**
 * First durable growth-objective slice.
 *
 * This intentionally stops at verified evidence readiness. It does not create a
 * diagnosis, recommendation, outreach, content, ad spend, or website mutation
 * when the underlying growth evidence is missing. That boundary is deliberate:
 * later reasoning/execution steps can only be appended after this objective has
 * proven the workspace has observed evidence to reason from.
 */
export async function runGrowthClosedLoopObjective(workspaceId: string) {
  if (!workspaceId) throw new Error('workspace_id_required')

  const supabase = createServiceClient()
  const durable = await openOrResumeObjectiveRun({
    supabase,
    objectiveKey: OBJECTIVE_KEY,
    planVersion: PLAN_VERSION,
    scopeKind: 'workspace',
    workspaceId,
    actorKey: 'caye:growth',
    maxTransitions: MAX_TRANSITIONS,
    timeoutMs: TIMEOUT_MS,
    maxRunAgeMs: MAX_RUN_AGE_MS,
    metadata: { workflow: 'growth', phase: 'evidence_readiness', planVersion: PLAN_VERSION },
  })

  let finalSnapshot: EvidenceSnapshot | null = null
  const result = await runBoundedObjective({
    context: { workspaceId },
    allowedAuthority: new Set(['read', 'write_low']),
    completedSteps: durable.completedSteps,
    maxTransitions: durable.maxTransitions,
    transitionsAlreadyUsed: durable.transitionsUsed,
    timeoutMs: TIMEOUT_MS,
    onEvent: (event) => persistObjectiveEvent(supabase, durable.runId, durable.runnerToken, TIMEOUT_MS, event),
    steps: [
      {
        key: 'refresh_growth_evidence',
        authority: 'write_low',
        maxAttempts: 1,
        execute: async ({ workspaceId }) => runGrowthIngestion(workspaceId),
        verify: async ({ workspaceId }, effect) => {
          const snapshot = await readEvidenceSnapshot(workspaceId)
          return {
            ok: true,
            evidence: { effect, snapshot },
          }
        },
      },
      {
        key: 'assess_growth_evidence',
        authority: 'read',
        maxAttempts: 1,
        execute: async ({ workspaceId }) => readEvidenceSnapshot(workspaceId),
        verify: async (_context, effect) => {
          const snapshot = effect as EvidenceSnapshot
          finalSnapshot = snapshot
          const sourceIds = new Set(snapshot.sources.map((source) => source.id))
          const orphanObservation = snapshot.observations.find((observation) => !sourceIds.has(observation.source_id))
          return orphanObservation
            ? { ok: false, reason: 'growth_observation_source_mismatch', evidence: { orphanObservation } }
            : { ok: true, evidence: snapshot }
        },
      },
    ],
  })

  await finalizeObjectiveRun(supabase, durable.runId, durable.runnerToken, result, {
    ...durable.metadata,
    evidenceReady: finalSnapshot?.evidenceReady ?? false,
    blockers: finalSnapshot?.blockers ?? ['growth_evidence_snapshot_unavailable'],
  })

  let directionEvidence: Awaited<ReturnType<typeof recordObjectiveDirectionEvidence>> | { recorded: 0; unavailable: true; error: string }
  try {
    directionEvidence = await recordObjectiveDirectionEvidence(supabase, {
      runId: durable.runId,
      objectiveKey: OBJECTIVE_KEY,
      result,
      summary: finalSnapshot?.evidenceReady
        ? 'Growth objective refreshed and independently verified observed workspace growth evidence.'
        : 'Growth objective verified the workspace is not yet evidence-ready and preserved the blocker instead of fabricating a diagnosis.',
    })
  } catch (error) {
    directionEvidence = {
      recorded: 0,
      unavailable: true,
      error: error instanceof Error ? error.message : String(error),
    }
    console.error('[growth-objective] Direction evidence publication failed after durable finalization', error)
  }

  return {
    runId: durable.runId,
    snapshot: finalSnapshot,
    directionEvidence,
    ...result,
  }
}
