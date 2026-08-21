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

/**
 * Deterministic Auto voice routing (spec item 3). NOT an LLM call — the
 * spec is explicit that Auto must not use one just to pick a provider.
 * Ranks available providers by a fixed preference order and falls back
 * down the list when the top choice is unavailable (missing API key in
 * this environment), logging why.
 *
 * STT preference: OpenAI Realtime first — native server VAD/turn
 * detection AND native barge-in cancellation semantics in one session,
 * which is the harder property to get right by hand. Deepgram second —
 * cheaper, also has server VAD, used when OpenAI is unavailable or the
 * founder wants the cheaper path.
 *
 * TTS preference: ElevenLabs first — voice quality/character fit is a
 * named product requirement (spec item 11: "calm, competent, warm, not
 * theatrical"), and ElevenLabs' Flash tier is documented at ~75ms
 * time-to-first-byte, competitive with Deepgram Aura-2's sub-200ms.
 * Deepgram second — meaningfully cheaper per character and still
 * streaming/low-latency, reasonable Auto fallback when ElevenLabs is
 * unavailable or over budget.
 */
export function chooseSttProvider(
  preference: VoiceProviderPreference,
  capabilities: SttCapability[]
): { provider: SttProviderId; reason: string; fellBack: boolean } {
  const byId = new Map(capabilities.map((c) => [c.provider, c]))
  const rankedOrder: SttProviderId[] = ['openai-realtime', 'deepgram']

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
    throw new Error(`No STT provider available. Requested '${preference}': ${requested?.unavailableReason ?? 'not configured'}.`)
  }

  for (const id of rankedOrder) {
    const cap = byId.get(id)
    if (cap?.available) return { provider: id, reason: `auto: ${id} (highest-ranked available)`, fellBack: false }
  }
  throw new Error('No STT provider available — no configured API key for any known provider.')
}

export function chooseTtsProvider(
  preference: TtsProviderPreference,
  capabilities: TtsCapability[]
): { provider: TtsProviderId; reason: string; fellBack: boolean } {
  const byId = new Map(capabilities.map((c) => [c.provider, c]))
  const rankedOrder: TtsProviderId[] = ['elevenlabs', 'deepgram']

  if (preference !== 'auto') {
    const requested = byId.get(preference)
    if (requested?.available) {
      return { provider: preference, reason: `manual selection: ${preference}`, fellBack: false }
    }
    const fallback = rankedOrder.find((id) => id !== preference && byId.get(id)?.available)
    if (fallback) {
      return {
        provider: fallback,
        reason: `requested '${preference}' unavailable (${requested?.unavailableReason ?? 'not configured'}); fell back to ${fallback}`,
        fellBack: true,
      }
    }
    throw new Error(`No TTS provider available. Requested '${preference}': ${requested?.unavailableReason ?? 'not configured'}.`)
  }

  for (const id of rankedOrder) {
    const cap = byId.get(id)
    if (cap?.available) return { provider: id, reason: `auto: ${id} (highest-ranked available)`, fellBack: false }
  }
  throw new Error('No TTS provider available — no configured API key for any known provider.')
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
