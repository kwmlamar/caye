import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { bootSandboxAndLaunch } from './boot'
import { CODING_BASE_BRANCH, TRUSTED_CODING_REPOSITORY } from './closure-policy'

const DEFAULT_PREDICTION = 'The bounded patch will pass npm test and npm run build and can be pushed to an isolated review branch without modifying main. Passing branch checks will not be treated as production verification.'
const DEFAULT_ROLLBACK = 'Delete the isolated review branch and coding-session record/evidence if necessary. Main remains unchanged until a separately authorized merge; production rollback belongs to the deploy authority path.'

/** Starts a founder-authorized, branch-isolated engineering run. */
export async function startCodingSession(params: {
  task: string
  requestedBy: string
  prediction?: string
  rollbackPlan?: string
  workspaceId?: string | null
  objectiveRunId?: string | null
}): Promise<{ sessionId: string }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_coding_sessions')
    .insert({
      task: params.task,
      requested_by: params.requestedBy,
      status: 'booting',
      repository_full_name: TRUSTED_CODING_REPOSITORY,
      base_branch: CODING_BASE_BRANCH,
      prediction: params.prediction?.trim() || DEFAULT_PREDICTION,
      rollback_plan: params.rollbackPlan?.trim() || DEFAULT_ROLLBACK,
      workspace_id: params.workspaceId ?? null,
      objective_run_id: params.objectiveRunId ?? null,
      merge_authorized: false,
      deploy_authorized: false,
      production_verified: false,
    })
    .select('id')
    .single()

  if (error || !data) throw new Error(`Failed to create coding session: ${error?.message ?? 'unknown error'}`)
  const sessionId = data.id as string
  await bootSandboxAndLaunch(sessionId, params.task)
  return { sessionId }
}
