import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { beginDirectRun, failDirectRun, finishDirectRun, setRunStage } from '@/lib/caye-direct-runs'
import { withDirectRunContext } from '@/lib/caye-direct-run-context'
import {
  runFounderThreadTurn as runFounderThreadTurnBase,
  type FounderThreadTurnOptions,
  type FounderThreadTurnResult,
} from './founder-thread-turn-base'

export type { FounderThreadTurnOptions, FounderThreadTurnResult } from './founder-thread-turn-base'

export async function runFounderThreadTurn(
  workspaceId: string,
  threadId: string,
  message: string,
  options?: FounderThreadTurnOptions,
  attachmentArtifactIds?: readonly string[]
): Promise<FounderThreadTurnResult> {
  // Voice is intentionally kept latency-first. Typed Direct turns get a
  // durable run; short turns finish before the sidebar's polling interval,
  // while substantial investigations remain visible and controllable.
  if (options?.responseStyle === 'voice') {
    return runFounderThreadTurnBase(workspaceId, threadId, message, options, attachmentArtifactIds)
  }

  const supabase = createServiceClient()
  const run = await beginDirectRun(supabase, {
    workspaceId,
    threadId,
    objective: message.trim() || (attachmentArtifactIds?.length ? 'Review the attached files' : 'Continue this work'),
  })
  await setRunStage(supabase, run.id, attachmentArtifactIds?.length ? 'Reviewing the files…' : 'Understanding the request…')
  try {
    const result = await withDirectRunContext(run.id, () =>
      runFounderThreadTurnBase(workspaceId, threadId, message, options, attachmentArtifactIds)
    )
    await finishDirectRun(supabase, run.id)
    return result
  } catch (error) {
    await failDirectRun(supabase, run.id)
    throw error
  }
}
