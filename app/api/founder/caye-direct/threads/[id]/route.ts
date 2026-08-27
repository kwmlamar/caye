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
import { isInternalTurnBody, visibleBody, dedupeConsecutive } from '@/lib/caye-operator-messages'
import {
  getThread,
  getThreadEntities,
  getThreadMessages,
  describeEntity,
  renameThread,
  setThreadStatus,
} from '@/lib/caye-direct-threads'
import { runFounderThreadTurn } from '@/lib/caye-agent/founder-thread-turn'
import type { RequestedMode } from '@/lib/model-router/types'
import { resolveRichResultReferences } from '@/lib/caye-direct-rich-result-resolution'

const VALID_REQUESTED_MODES: readonly RequestedMode[] = ['auto', 'claude', 'openai', 'api']

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

  const messages = await Promise.all(dedupeConsecutive(
    rawMessages
      .filter((m) => !isInternalTurnBody(m.body))
      .map((m) => ({ ...m, body: visibleBody(m.body) }))
  ).map(async m => ({ ...m, rich_result: await resolveRichResultReferences(supabase, workspaceId, m.rich_result) })))

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

  // `model` is the Caye Direct model selector (2026-08-17) — omitted or
  // unrecognized falls through to undefined, which keeps runFounderThreadTurn
  // on its original cayeAgent()/execute.ts path exactly as before this
  // feature existed. founderUserId comes from the verified session above,
  // never from the request body — see runCayeDirectRouterTurn's doc comment.
  const requestedMode = VALID_REQUESTED_MODES.find((m) => m === model)

  try {
    const result = await runFounderThreadTurn(
      workspaceId,
      threadId,
      message ?? '',
      requestedMode ? { requestedMode, founderUserId: user.id } : undefined,
      attachments
    )
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Agent failed'
    if (msg === 'Thread not found') return NextResponse.json({ error: msg }, { status: 404 })
    if (msg === 'Invalid attachment') return NextResponse.json({ error: msg }, { status: 400 })
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
