import { NextRequest, NextResponse } from 'next/server'
import {
  createAnthropicResearchProvider,
  createAnthropicResearchSynthesizer,
} from '@/lib/research/anthropic'
import { runNextProductionResearchDesk } from '@/lib/research/desks/production'
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
 * Give due standing-mission desks first use of the research cron. When no desk is
 * due, preserve the existing founder/operator queued-research worker behavior.
 * Both paths retain their own idempotent SKIP LOCKED claims.
 */
export async function runResearchWorker(): Promise<Record<string, unknown>> {
  const workerId = `research-worker:${process.env.VERCEL_REGION || 'unknown'}`
  const desk = await runNextProductionResearchDesk(workerId)
  if (desk.status !== 'idle') return { kind: 'research-desk', ...desk }

  const provider = createAnthropicResearchProvider()
  const synthesize = createAnthropicResearchSynthesizer()
  const job = await runNextResearchJob({ workerId, provider, synthesize })
  return { kind: 'queued-research', ...job }
}
