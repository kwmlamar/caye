/**
 * GET   /api/founder/caye-direct/threads/:id?workspaceId=<uuid>
 * POST  /api/founder/caye-direct/threads/:id   { workspaceId, message }
 * PATCH /api/founder/caye-direct/threads/:id   { workspaceId, title?, status? }
 *
 * A single Caye Direct thread. GET returns metadata + resolved linked
 * entities + visible messages (same visibility rules as the operator
 * route: isInternalTurnBody filtered, tool markers stripped, consecutive
 * duplicates collapsed). POST sends a founder message IN THIS THREAD —
 * same agent, same caye_operator_messages table as every other Caye
 * Direct/WhatsApp turn, but context loading is thread-scoped
 * (loadDirectThreadContext) instead of the operator's global sliding
 * window. PATCH renames or archives.
 *
 * POST always sends as the founder, exactly like the legacy operator-
 * scoped route — there is still no way to send as another operator from
 * the dashboard. See app/api/founder/caye-direct/route.ts's doc comment.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { cayeAgent } from '@/lib/caye-agent'
import { persistAgentTurns, isInternalTurnBody, visibleBody, dedupeConsecutive } from '@/lib/caye-operator-messages'
import { resolveFounderOperator } from '@/lib/operator-identity'
import {
  getThread,
  getThreadEntities,
  getThreadMessages,
  describeEntity,
  renameThread,
  setThreadStatus,
  touchThread,
  linkMessageToThread,
  linkInsertedMessagesToThreads,
} from '@/lib/caye-direct-threads'
import { maybeGenerateThreadTitle, maybeRefreshThreadSummary } from '@/lib/caye-direct-threads-summarize'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id: threadId } = await params
  const supabase = createServiceClient()

  const thread = await getThread(supabase, workspaceId, threadId)
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  const [entities, rawMessages] = await Promise.all([
    getThreadEntities(supabase, threadId),
    getThreadMessages(supabase, threadId),
  ])

  const linkedEntities = await Promise.all(
    entities.map(async (e) => ({ ...e, label: await describeEntity(supabase, e) }))
  )

  const messages = dedupeConsecutive(
    rawMessages
      .filter((m) => !isInternalTurnBody(m.body))
      .map((m) => ({ ...m, body: visibleBody(m.body) }))
  )

  return NextResponse.json({ thread, linkedEntities, messages })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const { workspaceId, message } = body as { workspaceId?: string; message?: string }
  if (!workspaceId || !message?.trim()) {
    return NextResponse.json({ error: 'workspaceId and message are required' }, { status: 400 })
  }

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id: threadId } = await params
  const supabase = createServiceClient()

  const thread = await getThread(supabase, workspaceId, threadId)
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  // Sending into an archived thread resumes it — archiving hides a thread
  // from the default sidebar, it doesn't close the door on it. Without
  // this, a founder who messages an archived thread would have their
  // reply land somewhere the sidebar never shows again (listThreads
  // defaults to status: 'active'), which reads as the message vanishing.
  if (thread.status === 'archived') {
    await setThreadStatus(supabase, workspaceId, threadId, 'active')
  }

  const operator = await resolveFounderOperator(supabase, workspaceId)
  const callerName = operator?.name ?? 'Founder (dashboard)'

  const { data: inboundRow } = await supabase
    .from('caye_operator_messages')
    .insert({
      workspace_id: workspaceId,
      direction: 'inbound',
      wa_message_id: null,
      body: message,
      intent: null,
      claude_format: { role: 'user', content: message },
      operator_allowlist_id: operator?.id ?? null,
      operator_name: operator?.name ?? null,
      operator_role: operator?.role ?? 'founder',
      origin: 'dashboard',
    })
    .select('id')
    .single()
  if (inboundRow?.id) await linkMessageToThread(supabase, threadId, inboundRow.id, 'founder')

  try {
    const agentResult = await cayeAgent({
      mode: 'back-office',
      workspaceId,
      userMessage: message,
      callerRole: 'founder',
      callerName,
      operatorId: operator?.id ?? null,
      threadId,
    })

    const inserted = await persistAgentTurns(
      supabase,
      workspaceId,
      agentResult.newTurns,
      operator,
      undefined,
      undefined,
      'dashboard'
    )
    const insertedIds = inserted.map((r) => r.id)
    await Promise.all([
      ...insertedIds.map((id) => linkMessageToThread(supabase, threadId, id, 'founder')),
      linkInsertedMessagesToThreads(supabase, insertedIds, agentResult.linkedThreadIds),
      touchThread(supabase, threadId),
    ])

    // Fire once, before responding, so a fresh thread's title is ready by
    // the time the sidebar re-fetches — cheap/fast enough not to matter
    // for latency, and only ever runs while thread.title is still null.
    await maybeGenerateThreadTitle(workspaceId, threadId)
    // Summary refresh is a long-thread-resume optimization, not something
    // this reply depends on — don't make the founder wait on it.
    void maybeRefreshThreadSummary(workspaceId, threadId).catch(() => {})

    return NextResponse.json({ replyText: agentResult.replyText, threadId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Agent failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await req.json().catch(() => null)
  const { workspaceId, title, status } = (body ?? {}) as {
    workspaceId?: string
    title?: string
    status?: 'active' | 'archived'
  }
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id: threadId } = await params
  const supabase = createServiceClient()

  let ok = true
  if (title?.trim()) ok = (await renameThread(supabase, workspaceId, threadId, title)) && ok
  if (status) ok = (await setThreadStatus(supabase, workspaceId, threadId, status)) && ok

  if (!ok) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
