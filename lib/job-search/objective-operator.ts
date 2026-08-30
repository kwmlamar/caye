import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { runJobSearchPreparation } from '@/app/api/caye/job-search-prepare/route'
import { runJobSearchInspection } from '@/app/api/caye/job-search-inspect/route'
import { runBoundedObjective } from '@/lib/operator/objective-run'

export async function runFounderJobSearchObjective() {
  const supabase = createServiceClient()
  const before = await supabase.from('job_search_applications').select('id,status,updated_at').order('updated_at', { ascending: false }).limit(25)
  if (before.error) throw new Error(before.error.message)

  return runBoundedObjective({
    context: { supabase, before: before.data ?? [] },
    // Preparation and inspection are internal/reversible state changes only.
    // Submission/contact remains outside this objective and therefore cannot be
    // smuggled in by a planner without an explicit high-risk authority grant.
    allowedAuthority: new Set(['read', 'write_low']),
    maxTransitions: 8,
    timeoutMs: 50_000,
    steps: [
      {
        key: 'prepare_applications', authority: 'write_low', maxAttempts: 1,
        execute: async () => runJobSearchPreparation(),
        verify: async ({ supabase }, effect) => {
          const check = await supabase.from('job_search_runs').select('id,status,completed_at,stats,error').eq('run_type', 'apply').order('created_at', { ascending: false }).limit(1).maybeSingle()
          if (check.error) return { ok: false, reason: check.error.message }
          const skipped = effect && typeof effect === 'object' && ('skippedPaused' in effect || 'skippedDailyCap' in effect || 'skippedAlreadyRunning' in effect)
          if (skipped) return { ok: true, evidence: { effect, verified: 'bounded skip' } }
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
}
