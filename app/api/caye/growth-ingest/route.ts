import { NextRequest, NextResponse } from 'next/server'
import { generateGrowthDiagnosis } from '@/lib/growth/diagnose'
import { runAllGrowthIngestion } from '@/lib/growth/ingest'

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const stats = await runGrowthIngest()
    return NextResponse.json({ status: 'completed', stats })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'growth ingest failed' }, { status: 500 })
  }
}

/** Observe first, then diagnose strictly from the evidence that was actually captured. */
export async function runGrowthIngest(): Promise<Record<string, unknown>> {
  const ingestion = await runAllGrowthIngestion()
  const diagnoses = []
  for (const workspace of ingestion.workspaces) {
    try {
      diagnoses.push({ workspaceId: workspace.workspaceId, diagnosis: await generateGrowthDiagnosis(workspace.workspaceId) })
    } catch (error) {
      diagnoses.push({ workspaceId: workspace.workspaceId, error: error instanceof Error ? error.message : 'diagnosis_failed' })
    }
  }
  return { ...ingestion, diagnoses }
}
