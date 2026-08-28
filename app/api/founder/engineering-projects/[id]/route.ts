import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { createServiceClient } from '@/lib/supabase-server'
import { getEngineeringProjectSnapshot } from '@/lib/engineering-projects/store'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await requireFounder(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('engineering_projects').select('workspace_id').eq('id', id).maybeSingle()
  if (error) return NextResponse.json({ error: 'Could not resolve project scope' }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Engineering project not found' }, { status: 404 })
  try {
    const snapshot = await getEngineeringProjectSnapshot(data.workspace_id as string, id)
    return NextResponse.json({ type: 'engineering_project', snapshot })
  } catch {
    return NextResponse.json({ error: 'Engineering project unavailable' }, { status: 500 })
  }
}
