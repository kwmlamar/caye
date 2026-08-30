/**
 * POST /api/founder/caye-direct/voice/session
 *
 * Founder-only. Starts Caye Direct Live Voice and returns an ephemeral
 * browser credential. When OpenAI Realtime is available we mint a full
 * conversational realtime session so the same WebRTC connection can both
 * transcribe the founder and render Caye's authorized reply as natural audio.
 * Reasoning/tools/approvals still stay in Caye's founder thread path.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { getVoiceCapabilities, mintSttCredential } from '@/lib/caye-voice/providers'
import { mintNativeRealtimeCredential } from '@/lib/caye-voice/native-realtime'
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
    sttCredential =
      routing.sttProvider === 'openai-realtime'
        ? await mintNativeRealtimeCredential()
        : await mintSttCredential(routing.sttProvider)
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
    ttsVoiceId: sttCredential.connect.voice ?? routing.ttsProvider,
    capabilities,
  }
  return NextResponse.json(config)
}
