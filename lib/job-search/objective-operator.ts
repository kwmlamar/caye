import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { runJobSearchPreparation } from '@/app/api/caye/job-search-prepare/route'
import { runJobSearchInspection } from '@/app/api/caye/job-search-inspect/route'
import { recordObjectiveDirectionEvidence } from '@/lib/operator/direction-evidence'
import { runBoundedObjective } from '@/lib/operator/objective-run'
import { finalizeObjectiveRun, openOrResumeObjectiveRun, persistObjectiveEvent } from '@/lib/operator/objective-store'

const OBJECTIVE_KEY = 'founder_job_search_prepare_and_inspect'
const MAX_TRANSITIONS = 8
const TIMEOUT_MS = 50_000

export async function runFounderJobSearchObjective() {
  const supabase = createServiceClient()
  const before = await supabase.from('job_search_applications').select('id,status,updated_at').order('updated_at', { ascending: false }).limit(25)
  if (before.error) throw new Error(before.error.message)

  const durable = await openOrResumeObjectiveRun({
    supabase,
    objectiveKey: OBJECTIVE_KEY,
    scopeKind: 'founder',
    workspaceId: null,
    actorKey: 'founder',
    maxTransitions: MAX_TRANSITIONS,
    timeoutMs: TIMEOUT_MS,
    metadata: { workflow: 'job_search', phase: 'prepare_and_inspect' },
  })

  const result = await runBoundedObjective({
    context: { supabase, before: before.data ?? [] },
    // Preparation and inspection are internal/reversible state changes only.
    // Submission/contact remains outside this objective and therefore cannot be
    // smuggled in by a planner without an explicit high-risk authority grant.
    allowedAuthority: new Set(['read', 'write_low']),
    completedSteps: durable.completedSteps,
    maxTransitions: MAX_TRANSITIONS,
    timeoutMs: TIMEOUT_MS,
    onEvent: (event) => persistObjectiveEvent(supabase, durable.runId, event),
    steps: [
      {
        key: 'prepare_applications', authority: 'write_low', maxAttempts: 1,
        execute: async () => runJobSearchPreparation(),
        verify: async ({ supabase }, effect) => {
          const check = await supabase.from('job_search_runs').select('id,status,completed_at,stats,error').eq('run_type', 'apply').order('created_at', { ascending: false }).limit(1).maybeSingle()
          if (check.error) return { ok: false, reason: check.error.message }
          const skipped = effect && typeof effect === 'object' && ('skippedPaused' in effect || 'skippedDailyCap' in effect || 'skippedAlreadyRunning' in effect)
          if (skipped) return { ok: true, evidence: { effect, verified: 'bounded_skip' } }
          return { ok: check.data?.status === 'completed', evidence: { effect, run: check.data }, reason: check.data?.error ?? 'Preparation run not observed completed' }
        },
      },
      {
        key: 'inspect_prepared_applications', authority: 'write_low', maxAttempts: 2,
        execute: async () => runJobSearchInspection(),
        verify: async ({ supabase }, effect) => {
          const check = await supabase.from('job_search_applications').select('id,status,needs_human_reason,updated_at').eq('status', 'NEEDS_HUMAN').order('updated_at', { ascending: false }).limit(10)
          if (check.error) return { ok: false, reason: check.error.message }
          return { ok: true, evidence: { effect, observedApplications: check.data ?? [] } }
        },
      },
    ],
  })

  await finalizeObjectiveRun(supabase, durable.runId, result)

  const directionEvidence = await recordObjectiveDirectionEvidence(supabase, {
    runId: durable.runId,
    objectiveKey: OBJECTIVE_KEY,
    result,
    summary: 'Founder job-search objective completed preparation and inspection with authority checks and verified side effects.',
  })

  return { runId: durable.runId, directionEvidence, ...result }
}
