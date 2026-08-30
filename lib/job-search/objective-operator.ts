import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { runJobSearchPreparation } from '@/app/api/caye/job-search-prepare/route'
import { runJobSearchInspection } from '@/app/api/caye/job-search-inspect/route'
import { recordObjectiveDirectionEvidence } from '@/lib/operator/direction-evidence'
import { runBoundedObjective } from '@/lib/operator/objective-run'
import { finalizeObjectiveRun, openOrResumeObjectiveRun, persistObjectiveEvent } from '@/lib/operator/objective-store'

const OBJECTIVE_KEY = 'founder_job_search_prepare_and_inspect'
const PLAN_VERSION = '1'
const MAX_TRANSITIONS = 8
const TIMEOUT_MS = 50_000
const MAX_RUN_AGE_MS = 15 * 60_000

type InspectionEffect = {
  inspected?: number
  results?: Array<{ applicationId?: string; outcome?: string; reason?: string }>
}

export async function runFounderJobSearchObjective() {
  const supabase = createServiceClient()
  const before = await supabase.from('job_search_applications').select('id,status,updated_at').order('updated_at', { ascending: false }).limit(25)
  if (before.error) throw new Error(before.error.message)

  const durable = await openOrResumeObjectiveRun({
    supabase,
    objectiveKey: OBJECTIVE_KEY,
    planVersion: PLAN_VERSION,
    scopeKind: 'founder',
    workspaceId: null,
    actorKey: 'founder',
    maxTransitions: MAX_TRANSITIONS,
    timeoutMs: TIMEOUT_MS,
    maxRunAgeMs: MAX_RUN_AGE_MS,
    metadata: { workflow: 'job_search', phase: 'prepare_and_inspect', planVersion: PLAN_VERSION },
  })

  const result = await runBoundedObjective({
    context: { supabase, before: before.data ?? [] },
    // Preparation and inspection are internal/reversible state changes only.
    // Submission/contact remains outside this objective and therefore cannot be
    // smuggled in by a planner without an explicit high-risk authority grant.
    allowedAuthority: new Set(['read', 'write_low']),
    completedSteps: durable.completedSteps,
    maxTransitions: durable.maxTransitions,
    transitionsAlreadyUsed: durable.transitionsUsed,
    timeoutMs: TIMEOUT_MS,
    onEvent: (event) => persistObjectiveEvent(supabase, durable.runId, durable.runnerToken, TIMEOUT_MS, event),
    steps: [
      {
        key: 'prepare_applications', authority: 'write_low', maxAttempts: 1,
        execute: async () => runJobSearchPreparation(),
        verify: async ({ supabase }, effect) => {
          const skipped = effect && typeof effect === 'object' && ('skippedPaused' in effect || 'skippedDailyCap' in effect || 'skippedAlreadyRunning' in effect)
          if (skipped) return { ok: true, evidence: { effect, verified: 'bounded_skip' } }

          const runId = effect && typeof effect === 'object' && 'runId' in effect && typeof effect.runId === 'string'
            ? effect.runId
            : null
          if (!runId) return { ok: false, evidence: { effect }, reason: 'Preparation effect did not identify its durable run' }

          const check = await supabase
            .from('job_search_runs')
            .select('id,status,completed_at,stats,error')
            .eq('id', runId)
            .eq('run_type', 'apply')
            .maybeSingle()
          if (check.error) return { ok: false, reason: check.error.message }
          return {
            ok: check.data?.status === 'completed',
            evidence: { effect, run: check.data },
            reason: check.data?.error ?? 'Exact preparation run was not observed completed',
          }
        },
      },
      {
        key: 'inspect_prepared_applications', authority: 'write_low', maxAttempts: 2,
        execute: async () => runJobSearchInspection(),
        verify: async ({ supabase }, rawEffect) => {
          const effect = rawEffect as InspectionEffect
          const results = Array.isArray(effect?.results) ? effect.results : []
          const failed = results.filter((item) => item?.outcome === 'failed')
          if (failed.length > 0) {
            return {
              ok: false,
              evidence: { effect, failed },
              reason: `${failed.length} application inspection(s) failed`,
            }
          }

          const mutatedIds = results
            .filter((item) => item?.outcome === 'needs_human' || item?.outcome === 'ready_for_browser')
            .map((item) => item.applicationId)
            .filter((id): id is string => typeof id === 'string')

          if (mutatedIds.length === 0) {
            return { ok: true, evidence: { effect, verified: 'no_mutating_inspection_outcomes' } }
          }

          const check = await supabase
            .from('job_search_applications')
            .select('id,status,needs_human_reason,updated_at')
            .in('id', mutatedIds)
          if (check.error) return { ok: false, reason: check.error.message }

          const observed = check.data ?? []
          const observedIds = new Set(observed.filter((row) => row.status === 'NEEDS_HUMAN' && row.needs_human_reason).map((row) => row.id as string))
          const missing = mutatedIds.filter((id) => !observedIds.has(id))
          return {
            ok: missing.length === 0,
            evidence: { effect, observedApplications: observed, missing },
            reason: missing.length ? `Inspection side effects not observed for ${missing.length} application(s)` : undefined,
          }
        },
      },
    ],
  })

  await finalizeObjectiveRun(supabase, durable.runId, durable.runnerToken, result, durable.metadata)

  // Direction is an evidence sink, not part of the operational side effect.
  // Once the durable objective is finalized, evidence publication failure must
  // not turn verified work into an HTTP failure that a scheduler can replay.
  let directionEvidence: Awaited<ReturnType<typeof recordObjectiveDirectionEvidence>> | { recorded: 0; unavailable: true; error: string }
  try {
    directionEvidence = await recordObjectiveDirectionEvidence(supabase, {
      runId: durable.runId,
      objectiveKey: OBJECTIVE_KEY,
      result,
      summary: 'Founder job-search objective completed preparation and inspection with authority checks and verified side effects.',
    })
  } catch (error) {
    directionEvidence = {
      recorded: 0,
      unavailable: true,
      error: error instanceof Error ? error.message : String(error),
    }
    console.error('[objective-operator] Direction evidence publication failed after durable finalization', error)
  }

  return { runId: durable.runId, directionEvidence, ...result }
}
