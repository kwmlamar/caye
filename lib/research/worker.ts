import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { syncDirectRunForResearchRun } from '@/lib/caye-direct-runs'
import { surfaceFounderInvestigationUpdate } from './founder-investigation-updates'
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

async function projectFounderInvestigationUpdate(questionId: string): Promise<void> {
  const db = createServiceClient()
  const [briefResult, claimsResult] = await Promise.all([
    db.from('research_briefs').select('current_understanding,conflicting_evidence,material_changes,implications,recommendations').eq('question_id', questionId).order('revision', { ascending: false }).limit(1).maybeSingle(),
    db.from('research_claims').select('confidence').eq('question_id', questionId).in('status', ['current', 'contested']),
  ])
  if (briefResult.error) throw briefResult.error
  if (claimsResult.error) throw claimsResult.error
  if (!briefResult.data) return

  await surfaceFounderInvestigationUpdate(db, {
    questionId,
    synthesis: {
      brief: briefResult.data.current_understanding ?? '',
      claims: (claimsResult.data ?? []).map((claim) => ({ confidence: claim.confidence })),
      conflictingEvidence: briefResult.data.conflicting_evidence ?? [],
      materialChanges: briefResult.data.material_changes ?? [],
      implications: briefResult.data.implications ?? [],
      recommendations: briefResult.data.recommendations ?? [],
    },
  })
}

async function syncDirectRun(runId: string, status: 'completed' | 'failed'): Promise<void> {
  try {
    await syncDirectRunForResearchRun(createServiceClient(), runId, status)
  } catch (error) {
    console.error('[research-worker] Direct run sync failed', error)
  }
}

const DEFAULT_DEPENDENCIES: ResearchWorkerDependencies = {
  claimRun: claimResearchRun as (workerId: string) => Promise<ClaimedResearchRun | null>,
  loadQuestion: loadResearchQuestion,
  executeRun: executeResearchRun,
  failRun: failClaimedResearchRun,
}

/** Execute at most one queued research run. */
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

    try {
      await projectFounderInvestigationUpdate(question.id)
    } catch (projectionError) {
      console.error('[research-worker] founder investigation projection failed', projectionError)
    }
    await syncDirectRun(run.id, 'completed')

    return { ...result, runId: run.id, questionId: question.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await dependencies.failRun(run.id, message, input.provider.name)
    await syncDirectRun(run.id, 'failed')
    return { status: 'failed' as const, runId: run.id, questionId: run.question_id, error: message }
  }
}
