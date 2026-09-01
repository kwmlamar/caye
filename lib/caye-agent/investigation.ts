import 'server-only'
import { randomUUID } from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { createServiceClient } from '@/lib/supabase-server'
import { cayeAgent, type CayeAgentResult } from './index'
import type { RunInvestigationInput } from './investigation-base'
import {
  MAX_INVESTIGATION_CONTINUATIONS,
  summarizeInvestigation,
  buildExhaustionSummary,
} from './investigation-base'
import { currentDirectRunId } from '@/lib/caye-direct-run-context'
import { checkpointDirectRun, setRunStage } from '@/lib/caye-direct-runs'

export {
  MAX_INVESTIGATION_CONTINUATIONS,
  summarizeInvestigation,
  buildContinuationPrompt,
  buildExhaustionSummary,
} from './investigation-base'
export type { InvestigationDigest, RunInvestigationInput } from './investigation-base'

type SupabaseClient = ReturnType<typeof createServiceClient>
type PersistPass = (
  turns: Anthropic.MessageParam[],
  linkedThreadIds: string[],
  engineeringArtifactIds?: string[],
  businessArtifactIds?: string[],
  engineeringAnalysisIds?: string[]
) => Promise<void>

export async function runInvestigation(
  supabase: SupabaseClient,
  input: RunInvestigationInput,
  persistPassTurns: PersistPass
): Promise<CayeAgentResult> {
  const investigationId = randomUUID()
  const runId = currentDirectRunId()
  if (runId) await setRunStage(supabase, runId, 'Researching and working through the request…')

  let currentObjective = input.message
  let agentResult: CayeAgentResult = await cayeAgent({
    mode: 'back-office', workspaceId: input.workspaceId,
    userMessage: input.userMessageOverride ?? input.message,
    callerRole: 'founder', callerName: input.callerName, operatorId: input.operatorId,
    threadId: input.threadId,
    investigation: { id: investigationId, isContinuation: false, objective: input.message },
    engineeringOrigin: input.engineeringOrigin, channel: input.channel,
  })
  await persistPassTurns(agentResult.newTurns, agentResult.linkedThreadIds, agentResult.engineeringArtifactIds, agentResult.businessArtifactIds, agentResult.engineeringAnalysisIds)

  let continuations = 0
  while (agentResult.ranOutOfIterations && continuations < MAX_INVESTIGATION_CONTINUATIONS) {
    if (runId) {
      const checkpoint = await checkpointDirectRun(supabase, runId)
      if (checkpoint.decision !== 'continue') {
        const text = checkpoint.decision === 'pause'
          ? 'Paused. I finished the current step safely. Send me an update when you want me to continue.'
          : 'Stopped. I finished the current step safely and did not start another one.'
        const finalTurn: Anthropic.MessageParam = { role: 'assistant', content: [{ type: 'text', text }] }
        await persistPassTurns([finalTurn], [])
        return { ...agentResult, ranOutOfIterations: false, replyText: text }
      }
      if (checkpoint.steering) {
        currentObjective = `${currentObjective}\n\nFounder update: ${checkpoint.steering}`
        await setRunStage(supabase, runId, 'Continuing with your update…')
      } else {
        await setRunStage(supabase, runId, 'Continuing the research…')
      }
    }

    continuations++
    agentResult = await cayeAgent({
      mode: 'back-office', workspaceId: input.workspaceId, userMessage: currentObjective,
      callerRole: 'founder', callerName: input.callerName, operatorId: input.operatorId,
      threadId: input.threadId,
      investigation: { id: investigationId, isContinuation: true, objective: currentObjective },
      channel: input.channel,
    })
    await persistPassTurns(agentResult.newTurns, agentResult.linkedThreadIds, agentResult.engineeringArtifactIds, agentResult.businessArtifactIds, agentResult.engineeringAnalysisIds)
  }

  if (agentResult.ranOutOfIterations) {
    const digest = await summarizeInvestigation(supabase, investigationId, input.workspaceId)
    const groundedText = buildExhaustionSummary(digest, continuations + 1)
    const finalTurn: Anthropic.MessageParam = { role: 'assistant', content: [{ type: 'text', text: groundedText }] }
    await persistPassTurns([finalTurn], [])
    agentResult = { ...agentResult, replyText: groundedText }
  }
  return agentResult
}
