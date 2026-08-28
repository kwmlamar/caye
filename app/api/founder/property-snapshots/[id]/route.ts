import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { getPropertySnapshot } from '@/lib/property/store'

/** Resolves one semantic property id server-side after founder auth + workspace scoping. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  if (!await requireFounder(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const snapshot = await getPropertySnapshot(workspaceId, id)
  return snapshot
    ? NextResponse.json({ type: 'property_snapshot', snapshot })
    : NextResponse.json({ error: 'Property not found' }, { status: 404 })
}
