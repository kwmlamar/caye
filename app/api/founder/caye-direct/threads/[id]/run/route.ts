import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { getFounderThreadById, linkMessageToThread } from '@/lib/caye-direct-threads'
import { resolveFounderOperator } from '@/lib/operator-identity'
import { getDirectRun, requestDirectRunControl, steerDirectRun } from '@/lib/caye-direct-runs'

async function authorize(req: NextRequest, threadId: string) {
  const user = await requireFounder(req)
  if (!user) return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  const supabase = createServiceClient()
  const thread = await getFounderThreadById(supabase, threadId)
  if (!thread) return { response: NextResponse.json({ error: 'Thread not found' }, { status: 404 }) }
  return { supabase, thread }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize(req, id)
  if ('response' in auth) return auth.response
  return NextResponse.json(await getDirectRun(auth.supabase, id))
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize(req, id)
  if ('response' in auth) return auth.response
  const body = await req.json().catch(() => null)
  const runId = typeof body?.runId === 'string' ? body.runId : null
  const control = body?.action === 'pause' ? 'pause' : body?.action === 'stop' ? 'cancel' : null
  if (!runId || !control) return NextResponse.json({ error: 'runId and action are required' }, { status: 400 })
  const ok = await requestDirectRunControl(auth.supabase, { threadId: id, runId, control })
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Run is no longer active' }, { status: 409 })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize(req, id)
  if ('response' in auth) return auth.response
  const body = await req.json().catch(() => null)
  const runId = typeof body?.runId === 'string' ? body.runId : null
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  if (!runId || !message) return NextResponse.json({ error: 'runId and message are required' }, { status: 400 })
  const ok = await steerDirectRun(auth.supabase, { threadId: id, runId, message })
  if (!ok) return NextResponse.json({ error: 'Run is no longer accepting updates' }, { status: 409 })

  const operator = await resolveFounderOperator(auth.supabase, auth.thread.active_workspace_id)
  const { data: row, error } = await auth.supabase.from('caye_operator_messages').insert({
    workspace_id: auth.thread.active_workspace_id, direction: 'inbound', wa_message_id: null,
    body: message, intent: null, claude_format: { role: 'user', content: message },
    operator_allowlist_id: operator?.id ?? null, operator_name: operator?.name ?? null,
    operator_role: operator?.role ?? 'founder', origin: 'dashboard',
  }).select('id').single()
  if (error || !row?.id) return NextResponse.json({ error: 'Could not save update' }, { status: 500 })
  await linkMessageToThread(auth.supabase, id, row.id, 'founder')
  return NextResponse.json({ ok: true })
}
