/**
 * POST /api/founder/caye-direct/voice/turn
 *
 * Founder-only. Pure conversational turns take a deterministic, durable fast
 * path; every turn that could depend on workspace state, memory, tools,
 * permissions, approvals, or side effects still uses the normal Caye founder
 * control plane.
 */

import { after, NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { createServiceClient } from '@/lib/supabase-server'
import { getFounderThreadById, setThreadActiveWorkspace } from '@/lib/caye-direct-threads'
import { resolveAuthoritativeThreadWorkspace } from '@/lib/caye-direct-thread-scope'
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
      // A Direct thread can legitimately be displayed while its active workspace
      // differs from the dashboard's incidental workspace selection. The typed
      // thread endpoint already resolves that scope before calling the founder
      // turn runner. Voice must do the same or a perfectly valid visible thread
      // is misreported as "Thread not found".
      const supabase = createServiceClient()
      const thread = await getFounderThreadById(supabase, threadId)
      if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

      const casualReply = conversationalVoiceReply(message)
      if (casualReply) {
        mark('fast_path_hit')
        // Pure conversation needs no business workspace lookup. Persist it in
        // the thread's actual active workspace rather than the dashboard's
        // incidental workspace selection.
        const persistWorkspaceId = thread.active_workspace_id
        after(async () => {
          try {
            await persistConversationalVoiceTurn(persistWorkspaceId, threadId, message, casualReply)
          } catch (err) {
            console.error('[caye-voice] fast_path_persist_failed', {
              workspaceId: persistWorkspaceId,
              threadId,
              sessionId: sessionId ?? 'unknown',
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })
        logVoiceEvent({
          workspaceId: persistWorkspaceId,
          sessionId: sessionId ?? 'unknown',
          event: 'turn_finalized',
          reasoningBackend: 'voice_fast_path',
          durationMs: Date.now() - startedAt,
          characterCount: message.length,
          at: new Date().toISOString(),
        })
        return NextResponse.json({ replyText: casualReply, threadId, backend: 'voice_fast_path', activeWorkspaceId: persistWorkspaceId })
      }

      mark('fast_path_miss')
      const authoritativeWorkspaceId = await resolveAuthoritativeThreadWorkspace(supabase, threadId)
      const turnWorkspaceId = authoritativeWorkspaceId ?? workspaceId
      if (thread.active_workspace_id !== turnWorkspaceId) {
        const moved = await setThreadActiveWorkspace(supabase, thread.active_workspace_id, threadId, turnWorkspaceId)
        if (!moved) return NextResponse.json({ error: 'Workspace context changed; retry the turn.' }, { status: 409 })
      }

      mark('turn_start')
      const result = await runFounderThreadTurn(turnWorkspaceId, threadId, message, {
        requestedMode: 'auto',
        founderUserId: user.id,
        responseStyle: 'voice',
      })
      logVoiceEvent({
        workspaceId: turnWorkspaceId,
        sessionId: sessionId ?? 'unknown',
        event: 'turn_finalized',
        reasoningBackend: result.backend ?? 'auto',
        durationMs: Date.now() - startedAt,
        characterCount: message.length,
        at: new Date().toISOString(),
      })
      return NextResponse.json({
        ...result,
        activeWorkspaceId: turnWorkspaceId,
        workspaceContextSource: authoritativeWorkspaceId ? 'linked_subject' : 'dashboard',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Agent failed'
      console.error('[caye-voice] turn_failed', {
        workspaceId,
        threadId,
        sessionId: sessionId ?? 'unknown',
        error: msg,
      })
      if (msg === 'Thread not found') return NextResponse.json({ error: msg }, { status: 404 })
      if (msg === 'Thread has a stale property link' || msg === 'Thread authoritative subjects span multiple workspaces') {
        return NextResponse.json({ error: msg }, { status: 409 })
      }
      return NextResponse.json({ error: msg }, { status: 500 })
    }
  })
}
