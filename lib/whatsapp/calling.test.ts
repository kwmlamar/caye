import { afterEach, describe, expect, it } from 'vitest'
import { whatsappCallingConfigured } from './calling'

describe('whatsappCallingConfigured', () => {
  afterEach(() => {
    delete process.env.WHATSAPP_CALLING_ENABLED
    delete process.env.WHATSAPP_CALLING_BRIDGE_URL
  })

  it('fails closed unless both the feature flag and bridge are configured', () => {
    expect(whatsappCallingConfigured()).toBe(false)

    process.env.WHATSAPP_CALLING_ENABLED = 'true'
    expect(whatsappCallingConfigured()).toBe(false)

    process.env.WHATSAPP_CALLING_BRIDGE_URL = 'https://bridge.example.com'
    expect(whatsappCallingConfigured()).toBe(true)
  })
})
