import { NextRequest, NextResponse } from 'next/server'
import { createServerClient, createServiceClient } from '@/lib/supabase-server'

async function authedUserId(req: NextRequest): Promise<string | null> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const client = createServerClient(token)
  const { data: { user } } = await client.auth.getUser()
  return user?.id ?? null
}

export async function POST(req: NextRequest) {
  const userId = await authedUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { workspaceId?: string; initialCayeMessage?: string; title?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const workspaceId = body.workspaceId
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  }

  const supabase = createServiceClient()

  if (userId !== workspaceId) {
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const initialTitle = (body.title || '').trim() || null
  const { data, error } = await supabase
    .from('caye_threads')
    .insert({ workspace_id: workspaceId, user_id: userId, title: initialTitle })
    .select('id, title, created_at, updated_at')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Insert failed' }, { status: 500 })
  }

  // Optional seed message — used by the discovery flow to plant Caye's first greeting.
  if (body.initialCayeMessage && body.initialCayeMessage.trim()) {
    await supabase.from('caye_messages').insert({
      thread_id: data.id,
      role: 'caye',
      content: body.initialCayeMessage.trim(),
    })
  }

  return NextResponse.json(data)
}

export async function GET(req: NextRequest) {
  const userId = await authedUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_threads')
    .select('id, title, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data || [])
}
