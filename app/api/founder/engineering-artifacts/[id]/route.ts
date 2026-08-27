import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { getTrustedArtifact } from '@/lib/engineering/artifacts'

/** Resolves semantic artifact ids server-side; callers never supply storage URLs. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  if (!await requireFounder(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const artifact = await getTrustedArtifact(workspaceId, id)
  return artifact ? NextResponse.json({ type: 'engineering_artifact', artifact }) : NextResponse.json({ error: 'Artifact not found' }, { status: 404 })
}
