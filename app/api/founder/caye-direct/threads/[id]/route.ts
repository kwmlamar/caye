/**
 * A single founder-scoped Caye Direct thread.
 *
 * The dashboard sends workspaceId as the founder's current operating context.
 * Subject-linked threads may override that incidental selection when a
 * canonical entity owns a workspace (Property 001 is the first such subject).
 * Every actual agent/tool turn still executes against exactly one workspace.
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
import { resolveAuthoritativeThreadWorkspace } from '@/lib/caye-direct-thread-scope'
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

  try {
    const authoritativeWorkspaceId = await resolveAuthoritativeThreadWorkspace(supabase, threadId)
    const turnWorkspaceId = authoritativeWorkspaceId ?? workspaceId

    if (thread.active_workspace_id !== turnWorkspaceId) {
      const moved = await setThreadActiveWorkspace(supabase, thread.active_workspace_id, threadId, turnWorkspaceId)
      if (!moved) return NextResponse.json({ error: 'Workspace context changed; retry the turn.' }, { status: 409 })
    }

    // Plain founder Direct now defaults to the authenticated router path.
    // This keeps the verified founder identity available to canonical
    // capabilities without changing the attachment safety invariant:
    // runFounderThreadTurn still forces attachment turns onto the production
    // multimodal path because the router cannot see raw attachment blocks.
    const requestedMode = VALID_REQUESTED_MODES.find((m) => m === model) ?? 'auto'
    const result = await runFounderThreadTurn(
      turnWorkspaceId,
      threadId,
      message ?? '',
      { requestedMode, founderUserId: user.id },
      attachments
    )
    return NextResponse.json({
      ...result,
      activeWorkspaceId: turnWorkspaceId,
      workspaceContextSource: authoritativeWorkspaceId ? 'linked_subject' : 'dashboard',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Agent failed'
    if (msg === 'Thread not found') return NextResponse.json({ error: msg }, { status: 404 })
    if (msg === 'Invalid attachment') return NextResponse.json({ error: msg }, { status: 400 })
    if (msg === 'Too many attachments') return NextResponse.json({ error: `Send at most a few files at once.` }, { status: 400 })
    if (msg === 'Attachment unreadable') return NextResponse.json({ error: "Couldn't read that attachment right now — try again in a moment." }, { status: 502 })
    if (msg === 'Thread has a stale property link' || msg === 'Thread authoritative subjects span multiple workspaces') {
      return NextResponse.json({ error: msg }, { status: 409 })
    }
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
