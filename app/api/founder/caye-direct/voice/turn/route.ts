/**
 * POST /api/founder/caye-direct/voice/turn
 *
 * Founder-only. Pure conversational turns take a deterministic, durable fast
 * path; every turn that could depend on workspace state, memory, tools,
 * permissions, approvals, or side effects still uses the normal Caye founder
 * control plane.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { runFounderThreadTurn } from '@/lib/caye-agent/founder-thread-turn'
import { conversationalVoiceReply, persistConversationalVoiceTurn } from '@/lib/caye-voice/conversational-fast-path'
import { logVoiceEvent } from '@/lib/caye-voice/observability'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const { workspaceId, threadId, message, sessionId } = (body ?? {}) as {
    workspaceId?: string
    threadId?: string
    message?: string
    sessionId?: string
  }
  if (!workspaceId || !threadId || !message?.trim()) {
    return NextResponse.json({ error: 'workspaceId, threadId, and message are required' }, { status: 400 })
  }

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const startedAt = Date.now()
  try {
    const casualReply = conversationalVoiceReply(message)
    if (casualReply) {
      await persistConversationalVoiceTurn(workspaceId, threadId, message, casualReply)
      logVoiceEvent({
        workspaceId,
        sessionId: sessionId ?? 'unknown',
        event: 'turn_finalized',
        reasoningBackend: 'voice_fast_path',
        durationMs: Date.now() - startedAt,
        characterCount: message.length,
        at: new Date().toISOString(),
      })
      return NextResponse.json({ replyText: casualReply, threadId, backend: 'voice_fast_path' })
    }

    const result = await runFounderThreadTurn(workspaceId, threadId, message, {
      requestedMode: 'auto',
      founderUserId: user.id,
    })
    logVoiceEvent({
      workspaceId,
      sessionId: sessionId ?? 'unknown',
      event: 'turn_finalized',
      reasoningBackend: result.backend ?? 'auto',
      durationMs: Date.now() - startedAt,
      characterCount: message.length,
      at: new Date().toISOString(),
    })
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Agent failed'
    console.error('[caye-voice] turn_failed', {
      workspaceId,
      threadId,
      sessionId: sessionId ?? 'unknown',
      error: msg,
    })
    if (msg === 'Thread not found') return NextResponse.json({ error: msg }, { status: 404 })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
