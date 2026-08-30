import { NextRequest, NextResponse } from 'next/server'
import { runFounderJobSearchObjective } from '@/lib/job-search/objective-operator'

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const result = await runFounderJobSearchObjective()
    return NextResponse.json({ status: result.status, result })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
