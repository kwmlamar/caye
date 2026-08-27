import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { getTrustedAnalysis } from '@/lib/engineering/fea/analysis'

/** Resolves semantic analysis ids server-side; callers never supply storage URLs. Mirrors engineering-artifacts/[id]/route.ts. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  if (!await requireFounder(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const analysis = await getTrustedAnalysis(workspaceId, id)
  return analysis ? NextResponse.json({ type: 'engineering_analysis', analysis }) : NextResponse.json({ error: 'Analysis not found' }, { status: 404 })
}
