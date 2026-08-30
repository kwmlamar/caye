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

  it('falls back to browser speech when no cloud TTS provider is configured', () => {
    const result = chooseTtsProvider('auto', [
      tts({ provider: 'elevenlabs', available: false }),
      tts({ provider: 'deepgram', available: false }),
    ])
    expect(result.provider).toBe('browser')
    expect(result.fellBack).toBe(false)
    expect(result.reason).toContain('browser speech synthesis')
  })

  it('marks browser speech as a fallback when a missing cloud provider was manually requested', () => {
    const result = chooseTtsProvider('elevenlabs', [
      tts({ provider: 'elevenlabs', available: false, unavailableReason: 'ELEVENLABS_API_KEY not configured' }),
      tts({ provider: 'deepgram', available: false }),
    ])
    expect(result.provider).toBe('browser')
    expect(result.fellBack).toBe(true)
    expect(result.reason).toContain('ELEVENLABS_API_KEY not configured')
  })

  it('honors an explicit browser selection', () => {
    const result = chooseTtsProvider('browser', [])
    expect(result.provider).toBe('browser')
    expect(result.fellBack).toBe(false)
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

  it('keeps voice routing alive with browser TTS when cloud TTS keys are missing', () => {
    const capabilities: VoiceCapabilities = {
      stt: [stt({ provider: 'deepgram', available: true })],
      tts: [tts({ provider: 'elevenlabs', available: false }), tts({ provider: 'deepgram', available: false })],
    }
    const decision = decideVoiceRouting('auto', 'auto', capabilities)
    expect(decision.sttProvider).toBe('deepgram')
    expect(decision.ttsProvider).toBe('browser')
  })

  it('never uses an LLM call — this is a pure, synchronous decision', () => {
    const capabilities: VoiceCapabilities = {
      stt: [stt({ provider: 'openai-realtime', available: true })],
      tts: [tts({ provider: 'elevenlabs', available: true })],
    }
    const result = decideVoiceRouting('auto', 'auto', capabilities)
    expect(result).not.toBeInstanceOf(Promise)
  })
})
