import 'server-only'
import type { SttCredential } from './types'

const REALTIME_MODEL = process.env.CAYE_VOICE_OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1'
const TRANSCRIBE_MODEL = process.env.CAYE_VOICE_OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
const REALTIME_VOICE = process.env.CAYE_VOICE_OPENAI_VOICE || 'marin'

/**
 * Mint an ephemeral OpenAI Realtime conversational session for Caye Live Voice.
 *
 * The realtime model owns audio transport and voice rendering, but it does NOT
 * autonomously answer founder turns. Server VAD commits/transcribes the user's
 * speech with create_response disabled. Caye's existing founder thread turn is
 * still the authority for reasoning, tools, approvals, persistence and workspace
 * scope. Once that turn returns, the browser asks this same realtime session to
 * render the already-authorized Caye reply as natural audio.
 */
export async function mintNativeRealtimeCredential(): Promise<SttCredential> {
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
        type: 'realtime',
        model: REALTIME_MODEL,
        output_modalities: ['audio'],
        max_output_tokens: 900,
        instructions:
          'You are the realtime voice renderer for Caye. Never independently perform business actions or invent operational facts. When explicitly asked to render a Caye backend reply, speak it naturally, warmly, and concisely. Preserve its meaning and factual claims. Do not add new facts, promises, actions, or tool results.',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: TRANSCRIBE_MODEL },
            turn_detection: {
              type: 'server_vad',
              threshold: Number(process.env.CAYE_VOICE_VAD_THRESHOLD ?? '0.5'),
              prefix_padding_ms: 300,
              silence_duration_ms: Number(process.env.CAYE_VOICE_VAD_SILENCE_MS ?? '650'),
              create_response: false,
              interrupt_response: true,
            },
          },
          output: {
            voice: REALTIME_VOICE,
          },
        },
      },
    }),
  })

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 1000)
    throw new Error(`OpenAI native Realtime client secret mint failed: ${res.status} ${detail}`)
  }

  const json = (await res.json()) as { value: string; expires_at: number }
  return {
    provider: 'openai-realtime',
    token: json.value,
    expiresAt: new Date(json.expires_at * 1000).toISOString(),
    connect: {
      callsUrl: 'https://api.openai.com/v1/realtime/calls',
      model: REALTIME_MODEL,
      mode: 'native-voice',
      voice: REALTIME_VOICE,
    },
  }
}
