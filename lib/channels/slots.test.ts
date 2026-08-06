import { describe, it, expect, vi } from 'vitest'

// Neutralize the 'server-only' guard so vitest (node env) can load this
// module — same pattern as lib/caye-agent/tools/high-risk-gate.test.ts.
vi.mock('server-only', () => ({}))

const { deriveChannelState, slotForChannelType, whatsAppAvailability } = await import('./slots')

describe('slotForChannelType', () => {
  it('collapses both email providers onto one inbox slot', () => {
    expect(slotForChannelType('email')).toBe('inbox')
    expect(slotForChannelType('gmail')).toBe('inbox')
  })

  it('returns null for channel types with no slot (e.g. sms)', () => {
    expect(slotForChannelType('sms')).toBeNull()
  })
})

describe('whatsAppAvailability', () => {
  it('withholds until the line question has actually been answered', () => {
    expect(whatsAppAvailability(null)).toEqual({ available: false, reason: 'unknown_line' })
    expect(whatsAppAvailability({})).toEqual({ available: false, reason: 'unknown_line' })
  })

  it('withholds on a personal phone — migration would kill their WhatsApp', () => {
    expect(whatsAppAvailability({ whatsappLine: 'personal' })).toEqual({
      available: false,
      reason: 'personal_phone',
    })
  })

  it('allows a business line and a landline', () => {
    expect(whatsAppAvailability({ whatsappLine: 'business' })).toEqual({ available: true })
    // Landlines register by voice verification with nothing lost.
    expect(whatsAppAvailability({ whatsappLine: 'landline' })).toEqual({ available: true })
  })
})

describe('deriveChannelState', () => {
  it('does not ask a Zoho-connected workspace to connect Gmail', () => {
    // Bimini's shape: channel_type 'email' (Zoho), never 'gmail'. The bug
    // this guards against is Caye messaging a paying, fully-activated
    // customer to connect an inbox that has worked for months.
    const state = deriveChannelState(['email', 'instagram', 'messenger'], {
      whatsappLine: 'personal',
    })
    expect(state.connected).toContain('inbox')
    expect(state.missing).not.toContain('inbox')
    expect(state.next).toBeNull()
    expect(state.isLive).toBe(true)
  })

  it('offers the inbox first, before WhatsApp', () => {
    const state = deriveChannelState([], { whatsappLine: 'business' })
    expect(state.next).toBe('inbox')
    expect(state.missing).toEqual(['inbox', 'whatsapp', 'instagram', 'messenger'])
  })

  it('gates WhatsApp with a reason rather than dropping it silently', () => {
    const state = deriveChannelState(['gmail'], { whatsappLine: 'personal' })
    expect(state.missing).not.toContain('whatsapp')
    expect(state.gated).toContainEqual({ slot: 'whatsapp', reason: 'personal_phone' })
    expect(state.next).toBe('instagram')
  })

  it('never offers WhatsApp before the line question is answered', () => {
    const state = deriveChannelState(['gmail'], {})
    expect(state.missing).not.toContain('whatsapp')
    expect(state.gated).toContainEqual({ slot: 'whatsapp', reason: 'unknown_line' })
  })

  it('skips social the owner said guests do not use', () => {
    const state = deriveChannelState(['email'], {
      inventory: { instagram: false, messenger: true },
      whatsappLine: 'business',
    })
    expect(state.missing).toEqual(['whatsapp', 'messenger'])
    expect(state.gated).toContainEqual({ slot: 'instagram', reason: 'not_used' })
  })

  it('reports not-live for a workspace that connected nothing (the churn case)', () => {
    const state = deriveChannelState([], null)
    expect(state.isLive).toBe(false)
    expect(state.connected).toEqual([])
  })

  it('ignores inactive-derived duplicates by only receiving active types', () => {
    // getChannelState filters is_active; duplicate rows for one provider
    // must still collapse to a single slot.
    const state = deriveChannelState(['email', 'gmail'], { whatsappLine: 'business' })
    expect(state.connected).toEqual(['inbox'])
  })
})
