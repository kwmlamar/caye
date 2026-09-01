import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { bootSandboxAndLaunch } from './boot'
import { CODING_BASE_BRANCH, TRUSTED_CODING_REPOSITORY } from './closure-policy'

const DEFAULT_PREDICTION = 'The bounded patch will pass npm test and npm run build and can be pushed to an isolated review branch without modifying main. Passing branch checks will not be treated as production verification.'
const DEFAULT_ROLLBACK = 'Delete the isolated review branch and coding-session record/evidence if necessary. Main remains unchanged until a separately authorized merge; production rollback belongs to the deploy authority path.'

export type CanonicalCodingSessionOrigin = {
  recommendationId: string
  recommendationFingerprint: string
  workspaceId: string | null
  task: string
  provenance: Record<string, unknown>
}

/** Internal execution primitive. Self-improvement callers must arrive with canonical recommendation provenance. */
export async function startCanonicalCodingSession(origin: CanonicalCodingSessionOrigin): Promise<{ sessionId: string }> {
  const recommendationId = origin.recommendationId.trim()
  const fingerprint = origin.recommendationFingerprint.trim()
  const task = origin.task.trim()
  if (!recommendationId || !fingerprint || !task) throw new Error('Canonical recommendation provenance is required to start self-improvement')
  if (!origin.provenance || Object.keys(origin.provenance).length === 0) throw new Error('Canonical recommendation provenance evidence is required')

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_coding_sessions')
    .insert({
      task,
      requested_by: `canonical-recommendation:${recommendationId}`,
      status: 'booting',
      repository_full_name: TRUSTED_CODING_REPOSITORY,
      base_branch: CODING_BASE_BRANCH,
      prediction: DEFAULT_PREDICTION,
      rollback_plan: DEFAULT_ROLLBACK,
      workspace_id: origin.workspaceId,
      objective_run_id: null,
      recommendation_id: recommendationId,
      recommendation_fingerprint: fingerprint,
      recommendation_provenance: origin.provenance,
      self_improvement_session: true,
      merge_authorized: false,
      deploy_authorized: false,
      production_verified: false,
      learning_key: `canonical-recommendation:${recommendationId}`,
    })
    .select('id')
    .single()

  if (error || !data) {
    if (error?.code === '23505') throw new Error('A coding session already exists for this canonical recommendation')
    throw new Error(`Failed to create coding session: ${error?.message ?? 'unknown error'}`)
  }
  const sessionId = data.id as string
  await bootSandboxAndLaunch(sessionId, task)
  return { sessionId }
}
