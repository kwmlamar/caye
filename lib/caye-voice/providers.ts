import 'server-only'
import type { SttCredential, SttProviderId, TtsProviderId, VoiceCapabilities } from './types'

/**
 * Server-side provider capability probe, credential minting, and TTS
 * proxying. Real API keys never leave this module: STT gets a short-lived
 * ephemeral credential the browser connects to the provider with directly;
 * TTS is proxied end to end through our own route handler.
 *
 * Every shape here follows each provider's documented 2026 API surface.
 * Deepgram's real-time STT (the `wss://api.deepgram.com/v1/listen` path)
 * has been live-smoke-tested against a real account and confirmed working
 * (see mintDeepgramCredential's doc comment for what was found and fixed).
 * OpenAI Realtime and ElevenLabs remain unexercised — no OPENAI_API_KEY /
 * ELEVENLABS_API_KEY configured in this environment as of the last
 * verification pass. getVoiceCapabilities() correctly reports whichever
 * providers are unconfigured as unavailable rather than pretending one
 * exists.
 */

const OPENAI_REALTIME_TRANSCRIBE_MODEL = process.env.CAYE_VOICE_OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
const DEEPGRAM_STT_MODEL = process.env.CAYE_VOICE_DEEPGRAM_STT_MODEL || 'nova-3'
// 2026-08-17 live-test finding: the original 700ms default split one
// founder sentence into two separate real utterances (each with its own
// legitimate speech_final:true) because a natural mid-sentence pause
// exceeded it — reproduced deterministically with a synthesized 900ms gap,
// then confirmed fixed at these values with the same reproduction. Not a
// client-side bug: this is Deepgram's own endpointing genuinely deciding
// the speaker was done, twice. utterance_end_ms is kept higher than
// endpointing (it's the fallback signal, meant to be more patient, not
// tighter) — see mintDeepgramCredential's doc comment.
const DEEPGRAM_ENDPOINTING_MS = process.env.CAYE_VOICE_DEEPGRAM_ENDPOINTING_MS || '1200'
const DEEPGRAM_UTTERANCE_END_MS = process.env.CAYE_VOICE_DEEPGRAM_UTTERANCE_END_MS || '2000'
// "Rachel" (21m00Tcm4TlvDq8ikWAM) was the original placeholder default and
// is a documented-everywhere example voice ID — but it live-tested (2026-
// 08-16) as a 402 "Free users cannot use library voices via the API" on
// the real account: it isn't in that account's own voice roster (GET
// /v1/voices), only in ElevenLabs' shared public library, which the free
// tier can't call through the API at all. Replaced with "Sarah"
// (EXAVITQu4vr4xnSDxMaL, "Mature, Reassuring, Confident"), one of the 21
// voices actually returned by this account's own /v1/voices — live-tested
// and confirmed working (200, real streamed audio/mpeg). Still just a
// reasonable pick from what's available, not an audition — override via
// CAYE_VOICE_ELEVENLABS_VOICE_ID once the founder has actually listened.
const ELEVENLABS_VOICE_ID = process.env.CAYE_VOICE_ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'
const ELEVENLABS_MODEL = process.env.CAYE_VOICE_ELEVENLABS_MODEL || 'eleven_flash_v2_5'
const DEEPGRAM_TTS_VOICE = process.env.CAYE_VOICE_DEEPGRAM_TTS_MODEL || 'aura-2-thalia-en'

export function getVoiceCapabilities(): VoiceCapabilities {
  const hasOpenAi = !!process.env.OPENAI_API_KEY
  const hasDeepgramKey = !!process.env.DEEPGRAM_API_KEY
  const hasElevenLabs = !!process.env.ELEVENLABS_API_KEY

  return {
    stt: [
      {
        provider: 'openai-realtime',
        available: hasOpenAi,
        serverTurnDetection: true,
        typicalLatencyMs: 300,
        costPerMinuteUsd: 0.006, // gpt-4o-mini-transcribe class pricing; see report for gpt-realtime full-duplex alternative
        unavailableReason: hasOpenAi ? undefined : 'OPENAI_API_KEY not configured',
      },
      {
        provider: 'deepgram',
        available: hasDeepgramKey,
        serverTurnDetection: true,
        typicalLatencyMs: 300,
        costPerMinuteUsd: 0.0048, // Nova-3 monolingual pay-as-you-go
        unavailableReason: hasDeepgramKey ? undefined : 'DEEPGRAM_API_KEY not configured',
      },
    ],
    tts: [
      {
        provider: 'elevenlabs',
        available: hasElevenLabs,
        streaming: true,
        typicalLatencyMs: 75, // Flash v2.5, documented low-latency tier
        costPerCharacterUsd: 0.00012, // mid-tier plan rate; varies by plan, see report
        unavailableReason: hasElevenLabs ? undefined : 'ELEVENLABS_API_KEY not configured',
      },
      {
        provider: 'deepgram',
        available: hasDeepgramKey,
        streaming: true,
        typicalLatencyMs: 200, // Aura-2, sub-200ms documented
        costPerCharacterUsd: 0.00003, // $30/1M chars
        unavailableReason: hasDeepgramKey ? undefined : 'DEEPGRAM_API_KEY not configured',
      },
    ],
  }
}

/**
 * Mint a short-lived, scoped credential the browser can use to connect
 * DIRECTLY to the STT provider — no proxy hop for audio, which matters for
 * latency and for not routing raw mic audio through our own server.
 */
export async function mintSttCredential(provider: SttProviderId): Promise<SttCredential> {
  if (provider === 'openai-realtime') return mintOpenAiRealtimeCredential()
  if (provider === 'deepgram') return mintDeepgramCredential()
  throw new Error(`Unknown STT provider: ${provider}`)
}

/**
 * OpenAI Realtime *transcription* session (type: "transcription", not a
 * full conversational session) — server VAD does turn detection, streams
 * partial + final transcripts, and critically never generates its own
 * model response. That absence is deliberate: a transcription session has
 * no `response.create` path at all, so there is no way for it to speak on
 * Caye's behalf or call a tool — reasoning stays entirely with cayeAgent.
 * See lib/caye-agent/founder-thread-turn.ts and the "Caye remains the
 * authority" note in types.ts.
 */
async function mintOpenAiRealtimeCredential(): Promise<SttCredential> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured')

  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: OPENAI_REALTIME_TRANSCRIBE_MODEL },
            turn_detection: {
              type: 'server_vad',
              // Conservative thresholds (spec item 6): natural pauses in
              // speech shouldn't read as end-of-turn. Founder-tunable later
              // via env, not exposed as UI chrome yet per spec's "don't
              // overbuild settings now."
              threshold: Number(process.env.CAYE_VOICE_VAD_THRESHOLD ?? '0.5'),
              prefix_padding_ms: 300,
              silence_duration_ms: Number(process.env.CAYE_VOICE_VAD_SILENCE_MS ?? '700'),
            },
          },
        },
      },
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`OpenAI Realtime client_secrets mint failed: ${res.status} ${detail}`)
  }

  const json = (await res.json()) as { value: string; expires_at: number }
  return {
    provider: 'openai-realtime',
    token: json.value,
    expiresAt: new Date(json.expires_at * 1000).toISOString(),
    connect: {
      callsUrl: 'https://api.openai.com/v1/realtime/calls',
      model: OPENAI_REALTIME_TRANSCRIBE_MODEL,
    },
  }
}

/**
 * Deepgram short-lived token via POST /v1/auth/grant (2026-08-16, fixed
 * after a live smoke test — see the verification report). The original
 * implementation called POST /v1/projects/{id}/keys, which needs the
 * `keys:write` *management* scope and a project id; live-tested against a
 * real account and rejected with 403 INSUFFICIENT_PERMISSIONS. Deepgram's
 * own docs recommend /v1/auth/grant instead for exactly this use case — a
 * lighter-weight, Member-permission-level endpoint purpose-built for
 * short-lived client-distributable tokens, and it needs no project id at
 * all (removed from getVoiceCapabilities()'s Deepgram STT requirement
 * accordingly). Also live-tested against the same real account and
 * rejected with the same 403 — that half is an account-permission gap on
 * Deepgram's side (the key's role doesn't include token-grant issuance),
 * not a code bug; surfaced to the founder in the verification report
 * rather than worked around here. Direct real-time STT over the listen
 * endpoint with the raw account key, by contrast, was confirmed working
 * end to end (real interim/final transcripts, real VAD events) in the
 * same smoke test — so the STT pipeline itself is sound; only ephemeral
 * token issuance is currently blocked.
 */
async function mintDeepgramCredential(): Promise<SttCredential> {
  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY not configured')

  const ttlSeconds = 300
  const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl_seconds: ttlSeconds }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Deepgram token grant failed: ${res.status} ${detail}`)
  }

  const json = (await res.json()) as { access_token: string; expires_in?: number }
  return {
    provider: 'deepgram',
    token: json.access_token,
    expiresAt: new Date(Date.now() + (json.expires_in ?? ttlSeconds) * 1000).toISOString(),
    connect: {
      // utterance_end_ms added after the live smoke test: without it,
      // Deepgram never sends a standalone UtteranceEnd message at all (only
      // `endpointing` was set before, which just marks speech_final:true
      // inside a Results message) — DeepgramSttSession's onSpeechEnd was
      // wired to a message type that could never arrive. useVoiceSession.ts
      // already has a redundant safety net (onFinal also dispatches
      // user_speech_end), so this wasn't a user-visible hang, but a real
      // UtteranceEnd signal is Deepgram's documented, more robust way to
      // detect end-of-turn independent of the final-transcript timing.
      //
      // endpointing/utterance_end_ms values: see the DEEPGRAM_ENDPOINTING_MS
      // doc comment above — raised from 700/1000 to these after a live test
      // showed 700ms split one real sentence into two separate turns.
      wsUrl: `wss://api.deepgram.com/v1/listen?model=${DEEPGRAM_STT_MODEL}&punctuate=true&interim_results=true&vad_events=true&endpointing=${DEEPGRAM_ENDPOINTING_MS}&utterance_end_ms=${DEEPGRAM_UTTERANCE_END_MS}`,
    },
  }
}

/**
 * Proxy a text→speech request to the configured TTS provider and hand back
 * the raw streaming Response so the route handler can pipe its body
 * straight through to the browser. Neither provider's key ever reaches
 * the client.
 */
export async function fetchTtsAudioStream(provider: TtsProviderId, text: string): Promise<Response> {
  if (provider === 'elevenlabs') return fetchElevenLabsTts(text)
  if (provider === 'deepgram') return fetchDeepgramTts(text)
  throw new Error(`Unknown TTS provider: ${provider}`)
}

async function fetchElevenLabsTts(text: string): Promise<Response> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured')

  return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL,
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true },
    }),
  })
}

async function fetchDeepgramTts(text: string): Promise<Response> {
  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY not configured')

  return fetch(`https://api.deepgram.com/v1/speak?model=${DEEPGRAM_TTS_VOICE}&encoding=mp3`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  })
}

export const DEFAULT_TTS_VOICE_LABEL = `elevenlabs:${ELEVENLABS_VOICE_ID}|deepgram:${DEEPGRAM_TTS_VOICE}`
