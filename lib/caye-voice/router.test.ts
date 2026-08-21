import { describe, it, expect } from 'vitest'
import { decideVoiceRouting, chooseSttProvider, chooseTtsProvider } from './router'
import type { SttCapability, TtsCapability, VoiceCapabilities } from './types'

function stt(overrides: Partial<SttCapability> & { provider: SttCapability['provider'] }): SttCapability {
  return { available: true, serverTurnDetection: true, typicalLatencyMs: 300, costPerMinuteUsd: 0.005, ...overrides }
}
function tts(overrides: Partial<TtsCapability> & { provider: TtsCapability['provider'] }): TtsCapability {
  return { available: true, streaming: true, typicalLatencyMs: 100, costPerCharacterUsd: 0.0001, ...overrides }
}

describe('chooseSttProvider — Auto ranking', () => {
  it('prefers openai-realtime when both are available', () => {
    const result = chooseSttProvider('auto', [
      stt({ provider: 'openai-realtime', available: true }),
      stt({ provider: 'deepgram', available: true }),
    ])
    expect(result.provider).toBe('openai-realtime')
    expect(result.fellBack).toBe(false)
  })

  it('falls back to deepgram when openai-realtime is unavailable', () => {
    const result = chooseSttProvider('auto', [
      stt({ provider: 'openai-realtime', available: false, unavailableReason: 'no key' }),
      stt({ provider: 'deepgram', available: true }),
    ])
    expect(result.provider).toBe('deepgram')
  })

  it('throws when no STT provider is available at all', () => {
    expect(() =>
      chooseSttProvider('auto', [
        stt({ provider: 'openai-realtime', available: false }),
        stt({ provider: 'deepgram', available: false }),
      ])
    ).toThrow(/No STT provider available/)
  })

  it('honors a manual selection when that provider is available', () => {
    const result = chooseSttProvider('deepgram', [
      stt({ provider: 'openai-realtime', available: true }),
      stt({ provider: 'deepgram', available: true }),
    ])
    expect(result.provider).toBe('deepgram')
    expect(result.fellBack).toBe(false)
  })

  it('falls back with a reason when the manually-selected provider is unavailable', () => {
    const result = chooseSttProvider('openai-realtime', [
      stt({ provider: 'openai-realtime', available: false, unavailableReason: 'OPENAI_API_KEY not configured' }),
      stt({ provider: 'deepgram', available: true }),
    ])
    expect(result.provider).toBe('deepgram')
    expect(result.fellBack).toBe(true)
    expect(result.reason).toContain('OPENAI_API_KEY not configured')
  })
})

describe('chooseTtsProvider — Auto ranking', () => {
  it('prefers elevenlabs, falls back to deepgram', () => {
    expect(
      chooseTtsProvider('auto', [tts({ provider: 'elevenlabs', available: true }), tts({ provider: 'deepgram', available: true })]).provider
    ).toBe('elevenlabs')
    expect(
      chooseTtsProvider('auto', [tts({ provider: 'elevenlabs', available: false }), tts({ provider: 'deepgram', available: true })]).provider
    ).toBe('deepgram')
  })

  it('throws when no TTS provider is available', () => {
    expect(() =>
      chooseTtsProvider('auto', [tts({ provider: 'elevenlabs', available: false }), tts({ provider: 'deepgram', available: false })])
    ).toThrow(/No TTS provider available/)
  })
})

describe('decideVoiceRouting', () => {
  it('combines STT and TTS decisions and flags fellBack if either fell back', () => {
    const capabilities: VoiceCapabilities = {
      stt: [stt({ provider: 'openai-realtime', available: false }), stt({ provider: 'deepgram', available: true })],
      tts: [tts({ provider: 'elevenlabs', available: true }), tts({ provider: 'deepgram', available: true })],
    }
    const decision = decideVoiceRouting('auto', 'auto', capabilities)
    expect(decision.sttProvider).toBe('deepgram')
    expect(decision.ttsProvider).toBe('elevenlabs')
    expect(decision.fellBack).toBe(false) // auto preference, not a manual fallback
  })

  it('never uses an LLM call — this is a pure, synchronous decision', () => {
    // Regression guard for spec item 3 ("Do NOT use an LLM merely to
    // choose the voice provider"): decideVoiceRouting must be a plain
    // sync function, not something that returns a Promise.
    const capabilities: VoiceCapabilities = {
      stt: [stt({ provider: 'openai-realtime', available: true })],
      tts: [tts({ provider: 'elevenlabs', available: true })],
    }
    const result = decideVoiceRouting('auto', 'auto', capabilities)
    expect(result).not.toBeInstanceOf(Promise)
  })
})
