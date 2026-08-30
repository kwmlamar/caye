/**
 * POST /api/founder/caye-direct/voice/tts
 *
 * Founder-only. Proxies text -> streamed audio from a configured CLOUD TTS
 * provider so the real provider API key never reaches the browser. Browser
 * speech synthesis is deliberately handled client-side and never reaches
 * this route.
 *
 * Falls back to the other configured cloud TTS provider on failure and
 * reports which one actually served the audio via X-Caye-Voice-Provider.
 *
 * Body: { text, provider: 'elevenlabs'|'deepgram', workspaceId, sessionId }
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { fetchTtsAudioStream, getVoiceCapabilities } from '@/lib/caye-voice/providers'
import { logVoiceEvent } from '@/lib/caye-voice/observability'
import type { TtsProviderId } from '@/lib/caye-voice/types'

type CloudTtsProviderId = Exclude<TtsProviderId, 'browser'>
const FALLBACK_ORDER: CloudTtsProviderId[] = ['elevenlabs', 'deepgram']

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const { text, provider, workspaceId, sessionId } = (body ?? {}) as {
    text?: string
    provider?: TtsProviderId
    workspaceId?: string
    sessionId?: string
  }
  if (!text?.trim() || !provider || !workspaceId) {
    return NextResponse.json({ error: 'text, provider, and workspaceId are required' }, { status: 400 })
  }
  if (provider === 'browser') {
    return NextResponse.json({ error: 'Browser TTS must be synthesized client-side' }, { status: 400 })
  }

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const capabilities = getVoiceCapabilities()
  const availableTts = new Set<CloudTtsProviderId>(capabilities.tts.filter((c) => c.available).map((c) => c.provider))
  const candidates: CloudTtsProviderId[] = [provider, ...FALLBACK_ORDER.filter((p) => p !== provider)].filter((p) => availableTts.has(p))

  if (candidates.length === 0) {
    return NextResponse.json({ error: 'No cloud TTS provider is configured in this environment' }, { status: 503 })
  }

  let lastError: string | null = null
  for (const candidate of candidates) {
    try {
      const startedAt = Date.now()
      const upstream = await fetchTtsAudioStream(candidate, text)
      if (!upstream.ok || !upstream.body) {
        lastError = `${candidate}: ${upstream.status} ${await upstream.text().catch(() => '')}`
        continue
      }
      if (candidate !== provider) {
        logVoiceEvent({
          workspaceId,
          sessionId: sessionId ?? 'unknown',
          event: 'tts_fallback',
          ttsProvider: candidate,
          fallbackReason: `requested ${provider} failed: ${lastError ?? 'unknown error'}`,
          at: new Date().toISOString(),
        })
      }
      logVoiceEvent({
        workspaceId,
        sessionId: sessionId ?? 'unknown',
        event: 'tts_start',
        ttsProvider: candidate,
        characterCount: text.length,
        durationMs: Date.now() - startedAt,
        at: new Date().toISOString(),
      })
      return new NextResponse(upstream.body, {
        headers: {
          'Content-Type': upstream.headers.get('content-type') ?? 'audio/mpeg',
          'X-Caye-Voice-Provider': candidate,
          'Cache-Control': 'no-store',
        },
      })
    } catch (err) {
      lastError = `${candidate}: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  logVoiceEvent({
    workspaceId,
    sessionId: sessionId ?? 'unknown',
    event: 'tts_failed',
    ttsProvider: provider,
    fallbackReason: lastError ?? 'all configured cloud TTS providers failed',
    at: new Date().toISOString(),
  })
  return NextResponse.json({ error: lastError ?? 'TTS failed' }, { status: 502 })
}
