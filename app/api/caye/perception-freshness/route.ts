import { NextRequest, NextResponse } from 'next/server'
import { runPerceptionFreshnessSweep } from '@/lib/perception/freshness'

function cronAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false

  const authorization = request.headers.get('authorization')
  const legacy = request.headers.get('x-cron-secret')
  return authorization === `Bearer ${secret}` || legacy === secret
}

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Perception freshness monitor unavailable' }, { status: 503 })
  }

  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runPerceptionFreshnessSweep()
    return NextResponse.json(result)
  } catch (error) {
    console.error('[perception-freshness] sweep failed', error)
    return NextResponse.json({ error: 'Perception freshness sweep failed' }, { status: 500 })
  }
}
