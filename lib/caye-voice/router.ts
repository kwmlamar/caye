import type {
  SttCapability,
  SttProviderId,
  TtsCapability,
  TtsProviderId,
  TtsProviderPreference,
  VoiceCapabilities,
  VoiceProviderPreference,
  VoiceRoutingDecision,
} from './types'

interface ProviderCapability<Id extends string> {
  provider: Id
  available: boolean
  unavailableReason?: string
}

/**
 * Shared ranking/fallback logic behind chooseSttProvider and
 * chooseTtsProvider below — identical for both (build an availability map,
 * honor a manual pick if available, else fall back down a ranked list,
 * else throw), differing only in the id type and the ranked order.
 */
function chooseProvider<Id extends string>(
  kind: 'STT' | 'TTS',
  preference: Id | 'auto',
  capabilities: ProviderCapability<Id>[],
  rankedOrder: Id[]
): { provider: Id; reason: string; fellBack: boolean } {
  const byId = new Map(capabilities.map((c) => [c.provider, c]))

  if (preference !== 'auto') {
    const requested = byId.get(preference)
    if (requested?.available) {
      return { provider: preference, reason: `manual selection: ${preference}`, fellBack: false }
    }
    // Requested provider unavailable — fall through to Auto ranking, but
    // record that this was a fallback from a manual pick.
    const fallback = rankedOrder.find((id) => id !== preference && byId.get(id)?.available)
    if (fallback) {
      return {
        provider: fallback,
        reason: `requested '${preference}' unavailable (${requested?.unavailableReason ?? 'not configured'}); fell back to ${fallback}`,
        fellBack: true,
      }
    }
    throw new Error(`No ${kind} provider available. Requested '${preference}': ${requested?.unavailableReason ?? 'not configured'}.`)
  }

  for (const id of rankedOrder) {
    const cap = byId.get(id)
    if (cap?.available) return { provider: id, reason: `auto: ${id} (highest-ranked available)`, fellBack: false }
  }
  throw new Error(`No ${kind} provider available — no configured API key for any known provider.`)
}

/**
 * Deterministic Auto voice routing (spec item 3). NOT an LLM call — the
 * spec is explicit that Auto must not use one just to pick a provider.
 * Ranks available providers by a fixed preference order and falls back
 * down the list when the top choice is unavailable (missing API key in
 * this environment), logging why.
 *
 * OpenAI Realtime first — native server VAD/turn detection AND native
 * barge-in cancellation semantics in one session, which is the harder
 * property to get right by hand. Deepgram second — cheaper, also has
 * server VAD, used when OpenAI is unavailable or the founder wants the
 * cheaper path.
 */
export function chooseSttProvider(
  preference: VoiceProviderPreference,
  capabilities: SttCapability[]
): { provider: SttProviderId; reason: string; fellBack: boolean } {
  return chooseProvider('STT', preference, capabilities, ['openai-realtime', 'deepgram'])
}

/**
 * Deterministic Auto voice routing (spec item 3) — see chooseSttProvider
 * above for why this isn't an LLM call.
 *
 * ElevenLabs first — voice quality/character fit is a named product
 * requirement (spec item 11: "calm, competent, warm, not theatrical"), and
 * ElevenLabs' Flash tier is documented at ~75ms time-to-first-byte,
 * competitive with Deepgram Aura-2's sub-200ms. Deepgram second —
 * meaningfully cheaper per character and still streaming/low-latency, a
 * reasonable Auto fallback when ElevenLabs is unavailable or over budget.
 */
export function chooseTtsProvider(
  preference: TtsProviderPreference,
  capabilities: TtsCapability[]
): { provider: TtsProviderId; reason: string; fellBack: boolean } {
  return chooseProvider('TTS', preference, capabilities, ['elevenlabs', 'deepgram'])
}

export function decideVoiceRouting(
  sttPreference: VoiceProviderPreference,
  ttsPreference: TtsProviderPreference,
  capabilities: VoiceCapabilities
): VoiceRoutingDecision {
  const stt = chooseSttProvider(sttPreference, capabilities.stt)
  const tts = chooseTtsProvider(ttsPreference, capabilities.tts)
  return {
    sttProvider: stt.provider,
    ttsProvider: tts.provider,
    reason: `${stt.reason}; ${tts.reason}`,
    fellBack: stt.fellBack || tts.fellBack,
  }
}
