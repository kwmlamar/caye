import { NextRequest, NextResponse } from 'next/server'
import { runNextRecommendationOutcomeObservation } from '@/lib/recommendations/observation-worker'
import { runMaterialIntelligenceRecommendations } from '@/lib/recommendations/production'
import { stageEligibleRecommendationActions } from '@/lib/recommendations/autonomous-worker'
import { runCrossDomainSynthesisIfDue } from '@/lib/research/cross-domain-production'
import { runNextProductionResearchDesk } from '@/lib/research/desks/production'
import {
  advanceResearchInvestigationLifecycle,
  queueDueResearchInvestigations,
  recordResearchInvestigationFailure,
} from '@/lib/research/investigation-lifecycle'
import { createResearchProviderSession } from '@/lib/research/providers/router'
import { recordResearchRoutingProvenance } from '@/lib/research/providers/provenance'
import { runNextResearchJob } from '@/lib/research/worker'

export const maxDuration = 300

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = request.headers.get('authorization')
  const legacy = request.headers.get('x-cron-secret')
  return auth === `Bearer ${secret}` || legacy === secret
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    return NextResponse.json(await runResearchWorker())
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}

async function runRecommendationsSafely() {
  try {
    return { status: 'completed' as const, ...(await runMaterialIntelligenceRecommendations()) }
  } catch (error) {
    return { status: 'failed' as const, error: error instanceof Error ? error.message : String(error) }
  }
}

async function runOutcomeObservationSafely(workerId: string) {
  try {
    return await runNextRecommendationOutcomeObservation(workerId)
  } catch (error) {
    return { status: 'failed' as const, error: error instanceof Error ? error.message : String(error) }
  }
}

async function wakeRecommendationActionsSafely() {
  try {
    return { status: 'completed' as const, ...(await stageEligibleRecommendationActions()) }
  } catch (error) {
    return { status: 'failed' as const, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * One existing worker carries outcome observation, recommendation proposal,
 * bounded recommendation-action wake, standing desks, durable investigations,
 * and the canonical queued research executor. No second cron/scheduler.
 */
export async function runResearchWorker(): Promise<Record<string, unknown>> {
  const workerId = `research-worker:${process.env.VERCEL_REGION || 'unknown'}`
  // Claim at most one due recommendation observation before paths that can return
  // early, so busy research work cannot starve objective outcome evidence.
  const outcomeObservation = await runOutcomeObservationSafely(workerId)
  const crossDomain = await runCrossDomainSynthesisIfDue()
  const recommendations = await runRecommendationsSafely()
  // Wake after recommendation generation on every tick. The queue contains only
  // canonical recommendation/version/decision identity, never executable prose.
  const recommendationActions = await wakeRecommendationActionsSafely()
  if (crossDomain.status !== 'idle') {
    return { kind: 'cross-domain-synthesis', outcomeObservation, recommendations, recommendationActions, ...crossDomain }
  }

  const desk = await runNextProductionResearchDesk(workerId)
  if (desk.status !== 'idle') return { kind: 'research-desk', outcomeObservation, recommendations, recommendationActions, ...desk }

  const dueQueued = await queueDueResearchInvestigations(3)
  const session = createResearchProviderSession()
  const binding = session.beginRun()
  const job = await runNextResearchJob({ workerId, provider: binding.provider, synthesize: binding.synthesize })
  if ('runId' in job && job.runId) {
    await recordResearchRoutingProvenance(job.runId, binding.provenance())
  }

  let lifecycle = null
  if ('questionId' in job && typeof job.questionId === 'string') {
    if (job.status === 'completed') {
      lifecycle = await advanceResearchInvestigationLifecycle(job.questionId)
    } else if (job.status === 'failed') {
      await recordResearchInvestigationFailure(job.questionId)
      lifecycle = { lifecycleStatus: 'active_or_paused', reason: 'research_run_failed' }
    }
  }

  return {
    kind: 'queued-research',
    provider: binding.provider.name,
    dueQueued,
    lifecycle,
    outcomeObservation,
    recommendations,
    recommendationActions,
    ...job,
  }
}
