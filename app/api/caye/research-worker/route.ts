import { NextRequest, NextResponse } from 'next/server'
import { runMaterialIntelligenceRecommendations } from '@/lib/recommendations/production'
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
    // Recommendation generation is downstream of canonical intelligence. A
    // transient model/provider failure must not turn a successful research or
    // synthesis cycle into a failed worker invocation.
    return { status: 'failed' as const, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * One existing worker carries the complete autonomous research loop:
 * cross-domain reassessment, grounded recommendation proposal, standing desks,
 * due durable investigations, then the canonical queued-run executor. No second
 * cron or shadow research queue.
 */
export async function runResearchWorker(): Promise<Record<string, unknown>> {
  const crossDomain = await runCrossDomainSynthesisIfDue()
  const recommendations = await runRecommendationsSafely()
  if (crossDomain.status !== 'idle') {
    return { kind: 'cross-domain-synthesis', recommendations, ...crossDomain }
  }

  const workerId = `research-worker:${process.env.VERCEL_REGION || 'unknown'}`
  const desk = await runNextProductionResearchDesk(workerId)
  if (desk.status !== 'idle') return { kind: 'research-desk', recommendations, ...desk }

  // A due investigation becomes an ordinary canonical research_run. The queue's
  // existing active-run uniqueness guard converges concurrent worker ticks.
  const dueQueued = await queueDueResearchInvestigations(3)

  // Provider choice is configuration, not a hard-wired vendor. The session
  // remembers a provider that fails permanently so one exhausted account cannot
  // be re-dialled for every remaining question in this invocation.
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

  return { kind: 'queued-research', provider: binding.provider.name, dueQueued, lifecycle, recommendations, ...job }
}
