import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import {
  claimResearchRun,
  executeResearchRun,
  type ResearchProvider,
} from './runtime'

export type ResearchSynthesizer = Parameters<typeof executeResearchRun>[0]['synthesize']

type ClaimedResearchRun = {
  id: string
  question_id: string
}

type ResearchQuestion = {
  id: string
  question: string
  status: string
}

type ResearchWorkerDependencies = {
  claimRun: (workerId: string) => Promise<ClaimedResearchRun | null>
  loadQuestion: (questionId: string) => Promise<ResearchQuestion>
  executeRun: typeof executeResearchRun
  failRun: (runId: string, error: string, provider: string) => Promise<void>
}

async function loadResearchQuestion(questionId: string): Promise<ResearchQuestion> {
  const db = createServiceClient()
  const { data, error } = await db
    .from('research_questions')
    .select('id,question,status')
    .eq('id', questionId)
    .maybeSingle()

  if (error) throw error
  if (!data || data.status === 'archived') throw new Error('Research question is unavailable')
  return data
}

async function failClaimedResearchRun(runId: string, error: string, provider: string): Promise<void> {
  const db = createServiceClient()
  const result = await db
    .from('research_runs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      provider,
      error,
    })
    .eq('id', runId)
    .eq('status', 'running')

  if (result.error) throw result.error
}

const DEFAULT_DEPENDENCIES: ResearchWorkerDependencies = {
  claimRun: claimResearchRun as (workerId: string) => Promise<ClaimedResearchRun | null>,
  loadQuestion: loadResearchQuestion,
  executeRun: executeResearchRun,
  failRun: failClaimedResearchRun,
}

/**
 * Execute at most one queued research run.
 *
 * Scheduling is intentionally outside this module. A cron route, queue consumer,
 * or manual operator can invoke the same worker with a concrete search provider
 * and synthesizer. No run is claimed until both dependencies are supplied.
 */
export async function runNextResearchJob(
  input: {
    workerId: string
    provider: ResearchProvider
    synthesize: ResearchSynthesizer
  },
  dependencies: ResearchWorkerDependencies = DEFAULT_DEPENDENCIES,
) {
  if (!input.workerId.trim()) throw new Error('workerId is required')

  const run = await dependencies.claimRun(input.workerId.trim())
  if (!run) return { status: 'idle' as const }

  try {
    const question = await dependencies.loadQuestion(run.question_id)
    const result = await dependencies.executeRun({
      runId: run.id,
      questionId: question.id,
      question: question.question,
      provider: input.provider,
      synthesize: input.synthesize,
    })

    return { ...result, runId: run.id, questionId: question.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    // executeResearchRun already marks failures/partials. This update is mainly
    // for failures that happen after claim but before execution begins. The
    // status predicate makes it harmless once executeResearchRun changed state.
    await dependencies.failRun(run.id, message, input.provider.name)
    return { status: 'failed' as const, runId: run.id, questionId: run.question_id, error: message }
  }
}
