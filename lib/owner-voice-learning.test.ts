import { describe, it, expect } from 'vitest'
import {
  isTrustedVoiceChannel,
  shouldRefreshOwnerVoiceProfile,
} from './owner-voice-trigger'

describe('isTrustedVoiceChannel', () => {
  it('trusts email (the only clean per-workspace channel today)', () => {
    expect(isTrustedVoiceChannel('email')).toBe(true)
  })

  it('rejects WhatsApp / Instagram / Messenger (shared test connections)', () => {
    // Per project_caye_channel_data_quality: these are shared across
    // workspaces and would pollute Karenda's voice profile with test data.
    expect(isTrustedVoiceChannel('whatsapp')).toBe(false)
    expect(isTrustedVoiceChannel('instagram')).toBe(false)
    expect(isTrustedVoiceChannel('messenger')).toBe(false)
  })

  it('rejects unknown channels', () => {
    expect(isTrustedVoiceChannel('sms')).toBe(false)
    expect(isTrustedVoiceChannel('')).toBe(false)
  })
})

describe('shouldRefreshOwnerVoiceProfile', () => {
  it('does not refresh below 10 owner messages since last update', () => {
    for (const n of [0, 1, 5, 9]) {
      expect(shouldRefreshOwnerVoiceProfile(n), `count=${n}`).toBe(false)
    }
  })

  it('refreshes at exactly 10 messages', () => {
    expect(shouldRefreshOwnerVoiceProfile(10)).toBe(true)
  })

  it('refreshes again at the next 10-message mark', () => {
    // The counter resets after a successful refresh, so 20 here represents
    // a future state where the reset failed and we crossed the threshold
    // again — still safe to refresh.
    expect(shouldRefreshOwnerVoiceProfile(20)).toBe(true)
  })
})
