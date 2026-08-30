import { NextRequest, NextResponse } from 'next/server'
import { runAllGrowthIngestion } from '@/lib/growth/ingest'

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const stats = await runGrowthIngest()
    return NextResponse.json({ status: 'completed', stats })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'growth ingest failed' }, { status: 500 })
  }
}

/** Read-only provider ingestion. Writes normalized evidence/source health only. */
export async function runGrowthIngest(): Promise<Record<string, unknown>> {
  return await runAllGrowthIngestion()
}
