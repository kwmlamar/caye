import { NextRequest, NextResponse } from 'next/server'
import { processPendingBusinessLearning } from '@/lib/business-learning/pipeline'

export const maxDuration = 60

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return process.env.NODE_ENV !== 'production'
  return request.headers.get('x-cron-secret') === secret || request.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const raw = Number(request.nextUrl.searchParams.get('limit') ?? 25)
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 100)) : 25
  try {
    const result = await processPendingBusinessLearning(limit)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[business-learning-cron] failed:', err)
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
