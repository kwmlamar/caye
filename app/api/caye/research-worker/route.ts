import { NextRequest, NextResponse } from 'next/server'
import { runCrossDomainSynthesisIfDue } from '@/lib/research/cross-domain-production'
import { runNextProductionResearchDesk } from '@/lib/research/desks/production'
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

/**
 * Cross-domain synthesis is checked first because a material belief revision
 * should be reassessed on the next 15-minute worker tick rather than waiting for
 * a standing desk slot. When synthesis is not due, preserve the existing desk
 * and founder/operator queued-research ordering.
 */
export async function runResearchWorker(): Promise<Record<string, unknown>> {
  const crossDomain = await runCrossDomainSynthesisIfDue()
  if (crossDomain.status !== 'idle') return { kind: 'cross-domain-synthesis', ...crossDomain }

  const workerId = `research-worker:${process.env.VERCEL_REGION || 'unknown'}`
  const desk = await runNextProductionResearchDesk(workerId)
  if (desk.status !== 'idle') return { kind: 'research-desk', ...desk }

  // Provider choice is configuration, not a hard-wired vendor. The session
  // remembers a provider that fails permanently so one exhausted account cannot
  // be re-dialled for every remaining question in this invocation.
  const session = createResearchProviderSession()
  const binding = session.beginRun()
  const job = await runNextResearchJob({ workerId, provider: binding.provider, synthesize: binding.synthesize })
  if ('runId' in job && job.runId) {
    await recordResearchRoutingProvenance(job.runId, binding.provenance())
  }
  return { kind: 'queued-research', provider: binding.provider.name, ...job }
}
