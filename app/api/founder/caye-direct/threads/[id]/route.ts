/**
 * A single founder-scoped Caye Direct thread.
 *
 * The dashboard still sends workspaceId because that is the founder's current
 * operating context. GET never mutates thread context. POST moves the thread's
 * active workspace to that explicit context (CAS) before running Caye, then
 * the entire agent/tool turn remains scoped to that one workspace.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { isInternalTurnBody, visibleBody, dedupeConsecutive } from '@/lib/caye-operator-messages'
import {
  getFounderThreadById,
  getThreadEntities,
  getThreadMessages,
  describeEntity,
  renameThread,
  setThreadStatus,
  setThreadPinned,
  setThreadActiveWorkspace,
  deleteThread,
} from '@/lib/caye-direct-threads'
import { runFounderThreadTurn } from '@/lib/caye-agent/founder-thread-turn'
import type { RequestedMode } from '@/lib/model-router/types'
import { resolveRichResultReferences } from '@/lib/caye-direct-rich-result-resolution'

const VALID_REQUESTED_MODES: readonly RequestedMode[] = ['auto', 'claude', 'openai', 'api']

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id: threadId } = await params
  const supabase = createServiceClient()
  const thread = await getFounderThreadById(supabase, threadId)
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  const [entities, rawMessages] = await Promise.all([
    getThreadEntities(supabase, threadId),
    getThreadMessages(supabase, threadId),
  ])
  const linkedEntities = await Promise.all(entities.map(async (e) => ({ ...e, label: await describeEntity(supabase, e) })))

  // A founder thread can now contain messages produced while operating in
  // different workspaces. Resolve every rich result against the workspace
  // that actually produced that message, never today's dashboard selection.
  const messages = await Promise.all(dedupeConsecutive(
    rawMessages
      .filter((m) => !isInternalTurnBody(m.body))
      .map((m) => ({ ...m, body: visibleBody(m.body) }))
  ).map(async (m) => ({
    ...m,
    rich_result: await resolveRichResultReferences(supabase, m.workspace_id, m.rich_result),
  })))

  return NextResponse.json({ thread, linkedEntities, messages })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const { workspaceId, message, model, attachmentArtifactIds } = body as {
    workspaceId?: string
    message?: string
    model?: string
    attachmentArtifactIds?: unknown
  }
  const attachments = Array.isArray(attachmentArtifactIds)
    ? attachmentArtifactIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : undefined
  if (!workspaceId || (!message?.trim() && !attachments?.length)) {
    return NextResponse.json({ error: 'workspaceId and a message or attachment are required' }, { status: 400 })
  }

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id: threadId } = await params
  const supabase = createServiceClient()
  const thread = await getFounderThreadById(supabase, threadId)
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  // The currently selected dashboard workspace is an explicit founder action.
  // Move context BEFORE the turn, then runFounderThreadTurn's getThread check
  // proves the runtime is executing in exactly that workspace. No tool can
  // silently reach sideways into another tenant during the same turn.
  if (thread.active_workspace_id !== workspaceId) {
    const moved = await setThreadActiveWorkspace(supabase, thread.active_workspace_id, threadId, workspaceId)
    if (!moved) return NextResponse.json({ error: 'Workspace context changed; retry the turn.' }, { status: 409 })
  }

  const requestedMode = VALID_REQUESTED_MODES.find((m) => m === model)
  try {
    const result = await runFounderThreadTurn(
      workspaceId,
      threadId,
      message ?? '',
      requestedMode ? { requestedMode, founderUserId: user.id } : undefined,
      attachments
    )
    return NextResponse.json({ ...result, activeWorkspaceId: workspaceId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Agent failed'
    if (msg === 'Thread not found') return NextResponse.json({ error: msg }, { status: 404 })
    if (msg === 'Invalid attachment') return NextResponse.json({ error: msg }, { status: 400 })
    if (msg === 'Too many attachments') return NextResponse.json({ error: `Send at most a few files at once.` }, { status: 400 })
    if (msg === 'Attachment unreadable') return NextResponse.json({ error: "Couldn't read that attachment right now — try again in a moment." }, { status: 502 })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await req.json().catch(() => null)
  const { title, status, pinned } = (body ?? {}) as {
    workspaceId?: string
    title?: string
    status?: 'active' | 'archived'
    pinned?: boolean
  }

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id: threadId } = await params
  const supabase = createServiceClient()
  const thread = await getFounderThreadById(supabase, threadId)
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  let ok = true
  const activeWorkspaceId = thread.active_workspace_id
  if (title?.trim()) ok = (await renameThread(supabase, activeWorkspaceId, threadId, title)) && ok
  if (status) ok = (await setThreadStatus(supabase, activeWorkspaceId, threadId, status)) && ok
  if (typeof pinned === 'boolean') ok = (await setThreadPinned(supabase, activeWorkspaceId, threadId, pinned)) && ok
  if (!ok) return NextResponse.json({ error: 'Thread changed concurrently' }, { status: 409 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id: threadId } = await params
  const supabase = createServiceClient()
  const thread = await getFounderThreadById(supabase, threadId)
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  const ok = await deleteThread(supabase, thread.active_workspace_id, threadId)
  if (!ok) return NextResponse.json({ error: 'Thread changed concurrently' }, { status: 409 })
  return NextResponse.json({ ok: true })
}
