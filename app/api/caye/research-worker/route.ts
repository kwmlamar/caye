import { NextRequest, NextResponse } from 'next/server'
import {
  createAnthropicResearchProvider,
  createAnthropicResearchSynthesizer,
} from '@/lib/research/anthropic'
import { runNextResearchJob } from '@/lib/research/worker'

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
 * Execute one queued founder/operator research run. The queue's unique active-run
 * constraint and SKIP LOCKED claim function provide concurrency safety.
 */
export async function runResearchWorker(): Promise<Record<string, unknown>> {
  const provider = createAnthropicResearchProvider()
  const synthesize = createAnthropicResearchSynthesizer()
  const workerId = `research-worker:${process.env.VERCEL_REGION || 'unknown'}`
  return runNextResearchJob({ workerId, provider, synthesize })
}
