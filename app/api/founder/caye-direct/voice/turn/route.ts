/**
 * POST /api/founder/caye-direct/voice/turn
 *
 * Founder-only. Takes a FINALIZED voice transcript (never an interim/
 * partial one — see useVoiceSession.ts, which only calls this once STT
 * reports the utterance final) and runs it through the exact same
 * runFounderThreadTurn() the text composer's POST /threads/:id uses —
 * same cayeAgent()/runToolLoop call, same tool roles, same gateHighRisk
 * confirmation gate, same action-claim-guard grounding, same
 * caye_operator_messages persistence. A spoken turn is written to the
 * SAME thread as typed turns (spec item 8: "same conversation"), so it
 * shows up in Caye Direct's text view immediately and survives after the
 * voice session ends.
 *
 * Body shape deliberately matches POST /threads/:id's
 * `{ workspaceId, message }` (plus an optional `sessionId` used only for
 * observability) — CayeDirectThread's `send()` posts to whichever endpoint
 * it's given with the same payload, so a finalized voice transcript is
 * quite literally "the same message send, different endpoint," not a
 * parallel code path with its own bubble/refetch/inFlightRuns handling.
 *
 * Body: { workspaceId, message, sessionId? }
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { runFounderThreadTurn } from '@/lib/caye-agent/founder-thread-turn'
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
    const result = await runFounderThreadTurn(workspaceId, threadId, message)
    logVoiceEvent({
      workspaceId,
      sessionId: sessionId ?? 'unknown',
      event: 'turn_finalized',
      reasoningBackend: 'claude-sonnet-4-6',
      durationMs: Date.now() - startedAt,
      characterCount: message.length,
      at: new Date().toISOString(),
    })
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Agent failed'
    if (msg === 'Thread not found') return NextResponse.json({ error: msg }, { status: 404 })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
