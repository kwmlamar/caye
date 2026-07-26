import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { bootSandboxAndLaunch } from './boot'

/**
 * Entry point for a `/code <task>` request. Inserts the session row, then
 * boots the sandbox synchronously (bounded — see boot.ts for why this
 * isn't fire-and-forget). Returns once the sandbox is running and the
 * Claude Code CLI has been launched detached inside it; the actual
 * multi-minute coding run is picked up by the cron poll route from here.
 */
export async function startCodingSession(params: {
  task: string
  requestedBy: string
}): Promise<{ sessionId: string }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_coding_sessions')
    .insert({ task: params.task, requested_by: params.requestedBy, status: 'booting' })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`Failed to create coding session: ${error?.message ?? 'unknown error'}`)
  }

  const sessionId = data.id as string
  await bootSandboxAndLaunch(sessionId, params.task)
  return { sessionId }
}
