/**
 * POST /api/founder/caye-direct/voice/session
 *
 * Founder-only (spec item 19, enforced server-side via requireFounder —
 * the same gate every other Caye Direct route uses). Starts a Caye Direct
 * Live Voice session: resolves Auto/manual provider routing, mints a
 * short-lived STT credential the browser will connect to the provider
 * with directly, and returns the TTS voice config the client will use
 * when calling /voice/tts per finalized reply.
 *
 * Body: { workspaceId, sttPreference?: 'auto'|'openai-realtime'|'deepgram',
 *         ttsPreference?: 'auto'|'elevenlabs'|'deepgram' }
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { getVoiceCapabilities, mintSttCredential } from '@/lib/caye-voice/providers'
import { decideVoiceRouting } from '@/lib/caye-voice/router'
import { logVoiceEvent, newVoiceSessionId } from '@/lib/caye-voice/observability'
import type { TtsProviderPreference, VoiceProviderPreference, VoiceSessionConfig } from '@/lib/caye-voice/types'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const { workspaceId, sttPreference, ttsPreference } = (body ?? {}) as {
    workspaceId?: string
    sttPreference?: VoiceProviderPreference
    ttsPreference?: TtsProviderPreference
  }
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const sessionId = newVoiceSessionId()
  const capabilities = getVoiceCapabilities()

  let routing
  try {
    routing = decideVoiceRouting(sttPreference ?? 'auto', ttsPreference ?? 'auto', capabilities)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'No voice provider available'
    logVoiceEvent({ workspaceId, sessionId, event: 'stt_failed', fallbackReason: msg, at: new Date().toISOString() })
    return NextResponse.json({ error: msg, capabilities }, { status: 503 })
  }

  logVoiceEvent({
    workspaceId,
    sessionId,
    event: 'routing_decision',
    sttProvider: routing.sttProvider,
    ttsProvider: routing.ttsProvider,
    fallbackReason: routing.fellBack ? routing.reason : undefined,
    at: new Date().toISOString(),
  })

  let sttCredential
  try {
    sttCredential = await mintSttCredential(routing.sttProvider)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to start speech session'
    logVoiceEvent({ workspaceId, sessionId, event: 'stt_failed', sttProvider: routing.sttProvider, fallbackReason: msg, at: new Date().toISOString() })
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  logVoiceEvent({ workspaceId, sessionId, event: 'session_start', sttProvider: routing.sttProvider, ttsProvider: routing.ttsProvider, at: new Date().toISOString() })

  const config: VoiceSessionConfig & { sessionId: string } = {
    sessionId,
    routing,
    sttCredential,
    ttsVoiceId: routing.ttsProvider,
    capabilities,
  }
  return NextResponse.json(config)
}
