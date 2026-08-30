/**
 * POST /api/founder/caye-direct/voice/turn
 *
 * Founder-only. Pure conversational turns take a deterministic, durable fast
 * path; every turn that could depend on workspace state, memory, tools,
 * permissions, approvals, or side effects still uses the normal Caye founder
 * control plane.
 *
 * Every turn runs inside withVoiceTurnTrace, which emits one
 * `[caye-voice] turn_timeline` line per turn with the server half of the
 * latency breakdown (auth, context build, reasoning, tools, persistence).
 * The browser half arrives separately via POST ../voice/telemetry.
 */

import { after, NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { runFounderThreadTurn } from '@/lib/caye-agent/founder-thread-turn'
import { conversationalVoiceReply, persistConversationalVoiceTurn } from '@/lib/caye-voice/conversational-fast-path'
import { logVoiceEvent } from '@/lib/caye-voice/observability'
import { mark, withVoiceTurnTrace } from '@/lib/caye-voice/latency'

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

  return withVoiceTurnTrace({ workspaceId, sessionId: sessionId ?? 'unknown' }, async () => {
    const user = await requireFounder(req)
    if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    mark('auth_ok')

    const startedAt = Date.now()
    try {
      const casualReply = conversationalVoiceReply(message)
      if (casualReply) {
        mark('fast_path_hit')
        // Persistence moves off the critical path via after(), the same
        // primitive the webhook routes already use for post-response work.
        // Caye already knows the exact words — every millisecond spent
        // writing them down is dead air on a turn whose whole point is that
        // it needed no lookup. after() (not a bare floating promise) is
        // what keeps the serverless invocation alive long enough for the
        // write to actually land; the turn is still durable, the write just
        // no longer sits between Caye deciding and Caye speaking.
        after(async () => {
          try {
            await persistConversationalVoiceTurn(workspaceId, threadId, message, casualReply)
          } catch (err) {
            console.error('[caye-voice] fast_path_persist_failed', {
              workspaceId,
              threadId,
              sessionId: sessionId ?? 'unknown',
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })
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

      mark('fast_path_miss')
      mark('turn_start')
      const result = await runFounderThreadTurn(workspaceId, threadId, message, {
        requestedMode: 'auto',
        founderUserId: user.id,
        // Restored 2026-08-30: commit 4628b6c3 added this and a later merge
        // silently dropped it, so voice replies were being generated with
        // the full 8192-token text budget and no spoken-form guidance, then
        // read aloud. See FounderThreadTurnOptions.responseStyle.
        responseStyle: 'voice',
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
  })
}
