/**
 * Provider-agnostic types for Caye Direct Live Voice (founder-only,
 * 2026-08-16). Shared between server routes (app/api/founder/caye-direct/
 * voice/*) and the client session controller
 * (components/dashboard/caye-direct/voice/*).
 *
 * Deliberately narrow: this is NOT a general voice-agent framework. It
 * exists to keep three concerns separable —
 *   1. speech input (STT + turn detection/VAD)
 *   2. reasoning (unchanged: cayeAgent/runToolLoop via
 *      lib/caye-agent/founder-thread-turn.ts)
 *   3. speech output (TTS)
 * — so a provider can be swapped on one side without touching the others,
 * and so the reasoning path can never be bypassed by a "native realtime"
 * provider's own tool-calling. See VOICE_ARCHITECTURE.md-equivalent notes
 * in the implementation report for the full rationale.
 */

/** Speech-to-text providers this abstraction knows how to drive. */
export type SttProviderId = 'openai-realtime' | 'deepgram'

/**
 * Text-to-speech providers this abstraction knows how to drive. `browser`
 * is the zero-secret safety net: cloud voices stay preferred, but a missing
 * ElevenLabs/Deepgram key must never make the whole live-voice session
 * unusable when the browser can already speak text locally.
 */
export type TtsProviderId = 'elevenlabs' | 'deepgram' | 'browser'

export type VoiceProviderPreference = 'auto' | SttProviderId
export type TtsProviderPreference = 'auto' | TtsProviderId

/**
 * What a provider can actually do, used by the Auto router. Populated from
 * static provider capability + which API keys are configured in this
 * environment (lib/caye-voice/providers.ts's capability probe) — never
 * from a live network check, so routing decisions are instant and don't
 * spend provider quota just to decide who to call.
 */
export interface SttCapability {
  provider: SttProviderId
  available: boolean
  /** Server VAD / turn detection built into the provider's own stream. */
  serverTurnDetection: boolean
  /** Provider-reported or measured-in-practice typical time-to-first-partial, ms. */
  typicalLatencyMs: number
  /** Rough cost per minute of audio in USD, for the cost-observability log and Auto's tie-breaking. */
  costPerMinuteUsd: number
  unavailableReason?: string
}

export interface TtsCapability {
  provider: Exclude<TtsProviderId, 'browser'>
  available: boolean
  /** Streaming/progressive audio (first-chunk-out before full utterance is synthesized). */
  streaming: boolean
  typicalLatencyMs: number
  costPerCharacterUsd: number
  unavailableReason?: string
}

export interface VoiceCapabilities {
  stt: SttCapability[]
  tts: TtsCapability[]
}

/** Result of Auto (or manual) provider selection, always logged (item 3/18 of the spec). */
export interface VoiceRoutingDecision {
  sttProvider: SttProviderId
  ttsProvider: TtsProviderId
  /** Human-readable reason Auto picked these — or why a manual pick fell back. */
  reason: string
  /** True when the founder's manual preference could not be honored and Auto substituted. */
  fellBack: boolean
}

/**
 * Ephemeral, short-lived credential minted server-side for the browser to
 * connect DIRECTLY to the STT provider (WebRTC for OpenAI Realtime,
 * WebSocket subprotocol token for Deepgram). The real API key never
 * leaves the server — see providers.ts's mintSttCredential. TTS is
 * deliberately NOT given this treatment: it's proxied through
 * /api/founder/caye-direct/voice/tts instead, since neither provider
 * offers a scoped-token story for TTS as clean as their STT/realtime
 * ephemeral-key support, and proxying keeps that key server-side too at
 * the cost of one extra hop. Browser speech is local and needs no key.
 */
export interface SttCredential {
  provider: SttProviderId
  /** Ephemeral token/client secret. Never the raw account API key. */
  token: string
  /** ISO timestamp; client must reconnect before this if the session runs long. */
  expiresAt: string
  /** Provider-specific connection info the client needs (model name, region, etc.). */
  connect: Record<string, string>
}

export interface VoiceSessionConfig {
  routing: VoiceRoutingDecision
  sttCredential: SttCredential
  ttsVoiceId: string
  capabilities: VoiceCapabilities
}

/** Turn-detection/session lifecycle states surfaced to the UI (spec item 6/14). */
export type VoiceUiState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'user-speaking'
  | 'thinking'
  | 'speaking'
  | 'error'

/** One founder-safe observability record (spec item 18). Never contains audio or transcript content. */
export interface VoiceObservabilityEvent {
  workspaceId: string
  sessionId: string
  event:
    | 'session_start'
    | 'session_end'
    | 'routing_decision'
    | 'stt_connected'
    | 'stt_failed'
    | 'turn_finalized'
    | 'tts_start'
    | 'tts_fallback'
    | 'tts_failed'
    | 'barge_in'
    | 'reasoning_backend_fallback'
  sttProvider?: SttProviderId
  ttsProvider?: TtsProviderId
  reasoningBackend?: string
  durationMs?: number
  characterCount?: number
  fallbackReason?: string
  at: string
}
